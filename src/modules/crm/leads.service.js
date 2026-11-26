// src/modules/crm/leads.service.js
// 2.0 Phase 3 — lead records, pipeline, activity timeline and follow-ups
// (PRD §4–§5). Access is enforced here, not in the UI:
//   • Consultants see and work only leads they own.
//   • Exam Coordinators see the leads assigned to them for the exam: they log
//     notes, schedule the exam, mark it done and record the payment.
//     The lead stays owned by its consultant.
//   • Application → Exam Scheduled when the exam is scheduled; → Course Done
//     automatically when Payment Status is set to Payment Done.
//   • Admins and Super Admins see all leads.
//   • Moving to Application records the ticket size (INR or USD).
//   • Closed leads (Not Interested / Junk) reopen only with a reason, by an Admin.
//   • "Course Done" is set by the team whenever they decide (no account, course
//     or progress check). The auto_course_done automation still moves a lead
//     there when its student completes the course. Enrollment and course
//     progress are tracked separately; certificates still need completion.

import { pool } from '../../config/db.js'
import { fmtIst } from '../../utils/ist.js'
import { managerIds, notify } from '../../utils/notify.js'
import env from '../../config/env.js'
import { audit } from '../../utils/audit.js'
import { getCompletionStatus } from '../certificates/certificates.service.js'
import { autoAssign } from './distribution.service.js'
import { isCrmManager } from '../../utils/access.js'
import { reauthenticate } from '../../utils/reauth.js'
import {
  CLOSED_STAGES,
  DISCUSSION_TYPES,
  EXAM_STATUSES,
  OPEN_STAGES_SQL,
  PAYMENT_TO_COURSE_DONE,
  REASON_REQUIRED,
  STAGE_LABELS,
  STAGES,
  TICKET_CURRENCIES,
  TRANSITIONS,
} from './crm.constants.js'

const fail = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra)
const MANAGERS = ['super_admin', 'admin']
// Admins, and Sub-Admins with CRM access (Team → Permissions), work every lead
const isManager = (actor) => isCrmManager(actor)
const COORDINATOR = 'exam_coordinator'
const isCoordinator = (actor) => actor?.role === COORDINATOR
/** Owner or Admin: may edit the lead, move it through the pipeline, assign a coordinator. */
const canManageLead = (actor, lead) => isManager(actor) || (lead.owner_id != null && lead.owner_id === actor?.id)

// ── Helpers ───────────────────────────────────────────────────────────────

/** Last 10 digits — matches "+91 98935 96975", "098935 96975" and "9893596975". */
export const normalizePhone = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '')
  return digits.length >= 7 ? digits.slice(-10) : null
}
export const normalizeEmail = (email) => {
  const e = String(email ?? '').trim().toLowerCase()
  return e.includes('@') ? e : null
}

const toSqlDate = (value) => new Date(value).toISOString().slice(0, 19).replace('T', ' ')
// "2026-11-26" means that day in IST (midnight IST = 18:30 UTC the day before)
const istDayStart = (d) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? new Date(`${d}T00:00:00+05:30`) : new Date(d)
const sqlToIso = (sql) => new Date(`${sql.replace(' ', 'T')}Z`).toISOString()

/** Start and end (UTC) of "today" in the business timezone. */
export const todayBounds = (tz = env.timezone, now = new Date()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  )
  // Offset of tz at this moment
  const asTz = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  const offsetMs = asTz.getTime() - new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  const startUtc = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs)
  return { start: toSqlDate(startUtc), end: toSqlDate(new Date(startUtc.getTime() + 86400e3)) }
}

const assertCrmUser = (actor) => {
  if (!isManager(actor) && actor?.role !== 'consultant' && !isCoordinator(actor)) {
    throw fail(403, 'The CRM is for consultants, exam coordinators and admins')
  }
}
/** Sales-side work (create, edit, follow-ups) — not for Exam Coordinators. */
const assertSalesUser = (actor) => {
  assertCrmUser(actor)
  if (isCoordinator(actor)) throw fail(403, "Exam coordinators can't do this — ask the lead's consultant")
}

/** WHERE fragment limiting leads to what the actor may see. */
export const scopeFor = (actor, alias = 'l') =>
  isManager(actor)
    ? { sql: '1 = 1', values: [] }
    : isCoordinator(actor)
      ? { sql: `${alias}.exam_coordinator_id = ?`, values: [actor.id] }
      : { sql: `${alias}.owner_id = ?`, values: [actor.id] }

/** May this actor see this lead? */
const canSeeLead = (actor, lead) =>
  isManager(actor) ||
  (isCoordinator(actor) ? lead.exam_coordinator_id === actor.id : lead.owner_id === actor.id)

const addActivity = (leadId, actorId, type, body = null, meta = null) =>
  pool.query('INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, ?, ?, ?, ?)', [
    leadId,
    actorId,
    type,
    body,
    meta ? JSON.stringify(meta) : null,
  ])

const getLeadRow = async (id) => {
  const [[row]] = await pool.query('SELECT * FROM leads WHERE id = ? AND archived_at IS NULL LIMIT 1', [id])
  return row ?? null
}

/** The lead, if the actor may see it; otherwise 404 (don't reveal it exists). */
const loadVisibleLead = async (actor, id) => {
  assertCrmUser(actor)
  const lead = await getLeadRow(id)
  if (!lead || !canSeeLead(actor, lead)) throw fail(404, 'Lead not found')
  return lead
}

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null)

/** Leads that look like the same person (normalised phone / email / platform id). */
export const findDuplicates = async ({ phone, email, source, platform_lead_id }, excludeId = null) => {
  const conds = []
  const values = []
  const p = normalizePhone(phone)
  const e = normalizeEmail(email)
  if (p) {
    conds.push('l.phone_norm = ?')
    values.push(p)
  }
  if (e) {
    conds.push('l.email_norm = ?')
    values.push(e)
  }
  if (platform_lead_id && source) {
    conds.push('(l.source = ? AND l.platform_lead_id = ?)')
    values.push(source, String(platform_lead_id))
  }
  if (!conds.length) return []
  const [rows] = await pool.query(
    `SELECT l.id, l.name, l.phone, l.email, l.stage, l.owner_id, u.name AS owner_name
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE l.archived_at IS NULL AND (${conds.join(' OR ')}) ${excludeId ? 'AND l.id <> ?' : ''}
     LIMIT 5`,
    excludeId ? [...values, excludeId] : values
  )
  return rows
}

/** An existing student account with this email, to link the lead to. */
export const findStudentId = async (email) => {
  const e = normalizeEmail(email)
  if (!e) return null
  const [[row]] = await pool.query('SELECT id FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL LIMIT 1', [e])
  return row?.id ?? null
}

const assertValidOwner = async (ownerId) => {
  if (ownerId == null) return
  const [[u]] = await pool.query('SELECT id, role, is_active FROM users WHERE id = ? AND deleted_at IS NULL', [ownerId])
  if (!u || !u.is_active || !['consultant', ...MANAGERS].includes(u.role)) {
    throw fail(400, 'Choose an active consultant or admin as the owner')
  }
}

// ── Create / edit ─────────────────────────────────────────────────────────

export const createLead = async (req, body) => {
  const actor = req.user
  assertSalesUser(actor)
  if (!body.phone && !body.email) throw fail(400, 'Add a phone number or an email')

  const duplicates = await findDuplicates(body)
  if (duplicates.length) {
    // Never silently create a second record for the same person (PRD §5)
    throw fail(409, 'This person may already be a lead', {
      details: {
        // Another consultant's lead: say it exists, nothing about it
        duplicates: duplicates.map((d) =>
          isManager(actor) || d.owner_id === actor.id ? d : { id: null, other_owner: true }
        ),
      },
    })
  }

  // Consultants own what they add; Admins may assign an owner or leave it unassigned
  const ownerId = isManager(actor) ? (body.owner_id ?? null) : actor.id
  await assertValidOwner(ownerId)

  const sourceMeta = body.source_meta && Object.keys(body.source_meta).length ? body.source_meta : null
  const [result] = await pool.query(
    `INSERT INTO leads (name, phone, phone_norm, email, email_norm, course_id, preferred_schedule, source,
       source_meta, platform_lead_id, consent, owner_id, assigned_by, assigned_at, stage, stage_changed_at,
       user_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(), ?, ?)`,
    [
      body.name.trim(),
      body.phone || null,
      normalizePhone(body.phone),
      body.email || null,
      normalizeEmail(body.email),
      body.course_id || null,
      body.preferred_schedule || null,
      body.source || 'manual',
      sourceMeta ? JSON.stringify(sourceMeta) : null,
      body.platform_lead_id || null,
      body.consent ? JSON.stringify(body.consent) : null,
      ownerId,
      ownerId ? actor.id : null,
      ownerId ? toSqlDate(new Date()) : null,
      await findStudentId(body.email),
      actor.id,
    ]
  )
  const id = result.insertId
  await addActivity(id, actor.id, 'created', null, { source: body.source || 'manual' })
  if (ownerId) await addActivity(id, actor.id, 'assignment', null, { to: ownerId, how: 'on_create' })
  // An Admin adding a lead for someone else: tell them (in-app + phone)
  if (ownerId && ownerId !== actor.id) {
    await notify(ownerId, {
      type: 'lead_assigned',
      title: 'New lead assigned to you',
      body: `${String(body.name).trim()}${body.phone ? ` · ${body.phone}` : ''}`,
      link: `/consultant/leads?lead=${id}`,
    })
  }
  await audit(req, { action: 'lead.create', targetType: 'lead', targetId: id, details: { source: body.source || 'manual', owner_id: ownerId } })
  // Admin chose "Auto (Round Robin)": distribute now (stays in the queue if no one can take it)
  if (!ownerId && isManager(actor) && body.auto_assign) await autoAssign(id, { req })
  return getLead(actor, id)
}

const cleanTicket = (size, currency) => {
  const amount = size == null || size === '' ? null : Math.round(Number(size) * 100) / 100
  if (amount != null && !(amount > 0)) throw fail(400, 'Enter a ticket size above 0')
  if (amount != null && !TICKET_CURRENCIES.includes(currency)) throw fail(400, 'Choose INR or USD for the ticket size')
  return { ticket_size: amount, ticket_currency: amount == null ? null : currency }
}

export const updateLead = async (req, id, body) => {
  const actor = req.user
  assertSalesUser(actor)
  const lead = await loadVisibleLead(actor, id)
  const ticket =
    body.ticket_size !== undefined || body.ticket_currency !== undefined
      ? cleanTicket(
          body.ticket_size !== undefined ? body.ticket_size : lead.ticket_size,
          body.ticket_currency ?? lead.ticket_currency
        )
      : { ticket_size: lead.ticket_size, ticket_currency: lead.ticket_currency }
  // The phone came from the lead source: only Admins change it (or the consultant who typed it in).
  // Consultants add a separate WhatsApp number instead.
  const newPhone = body.phone !== undefined ? body.phone || null : lead.phone
  if (String(newPhone ?? '') !== String(lead.phone ?? '') && !canEditPhone(actor, lead)) {
    throw fail(403, "The phone number comes from the lead source and can't be changed. Add a WhatsApp number instead.")
  }
  const next = {
    name: body.name ?? lead.name,
    phone: newPhone,
    whatsapp_number: body.whatsapp_number !== undefined ? body.whatsapp_number || null : lead.whatsapp_number ?? null,
    email: body.email !== undefined ? body.email || null : lead.email,
    course_id: body.course_id !== undefined ? body.course_id || null : lead.course_id,
    preferred_schedule: body.preferred_schedule !== undefined ? body.preferred_schedule || null : lead.preferred_schedule,
    ...ticket,
  }
  if (!next.phone && !next.email) throw fail(400, 'Keep a phone number or an email')
  const dup = await findDuplicates({ phone: next.phone, email: next.email }, lead.id)
  if (dup.length) throw fail(409, 'Another lead already has this phone or email', { details: { duplicates: dup.map((d) => ({ name: d.name, stage: d.stage })) } })

  const same = (k) =>
    k === 'ticket_size' ? Number(next[k] ?? 0) === Number(lead[k] ?? 0) : String(next[k] ?? '') === String(lead[k] ?? '')
  const changed = Object.keys(next).filter((k) => !same(k))
  if (!changed.length) return getLead(actor, lead.id)
  await pool.query(
    `UPDATE leads SET name = ?, phone = ?, phone_norm = ?, whatsapp_number = ?, email = ?, email_norm = ?, course_id = ?,
       preferred_schedule = ?, ticket_size = ?, ticket_currency = ?, user_id = COALESCE(user_id, ?) WHERE id = ?`,
    [
      next.name,
      next.phone,
      normalizePhone(next.phone),
      next.whatsapp_number,
      next.email,
      normalizeEmail(next.email),
      next.course_id,
      next.preferred_schedule,
      next.ticket_size,
      next.ticket_currency,
      await findStudentId(next.email),
      lead.id,
    ]
  )
  await addActivity(lead.id, actor.id, 'updated', null, { fields: changed })
  return getLead(actor, lead.id)
}

// ── Pipeline ──────────────────────────────────────────────────────────────

/** Enrollment and completion of the linked student, kept apart from the stage. */
const studentProgress = async (lead) => {
  if (!lead.user_id || !lead.course_id) {
    return { enrollment_status: lead.stage === 'application' ? 'application' : 'none', course_completed: false }
  }
  const [[pending]] = await pool.query(
    `SELECT id FROM payments WHERE user_id = ? AND course_id = ? AND status = 'pending' LIMIT 1`,
    [lead.user_id, lead.course_id]
  )
  const status = await getCompletionStatus(lead.user_id, lead.course_id)
  return {
    enrollment_status: status.enrolled
      ? 'enrolled'
      : pending
        ? 'payment_pending'
        : lead.stage === 'application'
          ? 'application'
          : 'none',
    course_completed: Boolean(status.complete),
    completion_note: status.complete ? null : status.reason ?? null,
  }
}

/** Exam done but not paid yet: shown in red on the Exam Scheduled tab. */
export const PAYMENT_ALERT_SQL = "(l.exam_done = 1 AND l.payment_status = 'due' AND l.stage NOT IN ('course_done', 'not_interested', 'junk'))"
const paymentAlert = (lead) => Boolean(lead.exam_done) && lead.payment_status !== 'done' && !['course_done', ...CLOSED_STAGES].includes(lead.stage)

/** Stages this actor may move the lead to now (Course Done only comes from Payment Done). */
const allowedNextStages = (actor, lead) => {
  if (isCoordinator(actor) || !canManageLead(actor, lead)) return []
  return TRANSITIONS[lead.stage] ?? []
}

/** Move a lead to a stage as a side effect of another update (timeline says why). */
const moveStageFor = async (lead, actor, stage, why) => {
  await pool.query(
    `UPDATE leads SET stage = ?, prior_stage = ?, stage_reason = ?, stage_changed_at = UTC_TIMESTAMP() WHERE id = ? AND stage = ?`,
    [stage, lead.stage, why, lead.id, lead.stage]
  )
  await addActivity(lead.id, actor.id, 'status_change', why, { from: lead.stage, to: stage, automatic: true })
}

export const changeStage = async (req, id, { stage, reason, ticket_size, ticket_currency, exam_scheduled_at }) => {
  const actor = req.user
  const lead = await loadVisibleLead(actor, id)
  if (!STAGES.includes(stage)) throw fail(400, 'Unknown stage')
  if (stage === lead.stage) throw fail(409, `This lead is already in ${STAGE_LABELS[stage]}`)
  if (stage === 'course_done') {
    throw fail(400, 'Course Done happens automatically when the Payment Status is set to Payment Done')
  }
  if (isCoordinator(actor)) throw fail(403, 'Exam coordinators update the exam and payment; the consultant manages the status')
  if (!canManageLead(actor, lead)) throw fail(403, "You can't change this lead's status")

  // The lead's consultant (or an Admin) may move it anywhere, backwards too; reopening needs a reason
  const reopening = CLOSED_STAGES.includes(lead.stage)
  if (!(TRANSITIONS[lead.stage] ?? []).includes(stage)) {
    throw fail(400, `A lead in ${STAGE_LABELS[lead.stage]} can't move to ${STAGE_LABELS[stage]}`)
  }
  const why = String(reason ?? '').trim()
  if ((REASON_REQUIRED.includes(stage) || reopening) && !why) {
    throw fail(400, reopening ? 'Give a reason for reopening this lead' : `Give a reason for ${STAGE_LABELS[stage]}`)
  }
  // Application records the expected deal value
  let ticket = null
  if (stage === 'application') {
    if (ticket_size == null || ticket_size === '') throw fail(400, 'Enter the ticket size to move this lead to Application')
    ticket = cleanTicket(ticket_size, ticket_currency)
  }
  // Exam Scheduled needs the exam date (the coordinator usually sets it from the Exam section)
  let examAt = null
  if (stage === 'exam_scheduled') {
    if (!exam_scheduled_at && !lead.exam_scheduled_at) throw fail(400, 'Choose the exam date and time')
    examAt = toSqlDate(exam_scheduled_at || lead.exam_scheduled_at)
  }

  await pool.query(
    `UPDATE leads SET stage = ?, prior_stage = ?, stage_reason = ?, stage_changed_at = UTC_TIMESTAMP(),
       disposition_reason = ?, first_contact_at = COALESCE(first_contact_at, ?),
       ticket_size = COALESCE(?, ticket_size), ticket_currency = COALESCE(?, ticket_currency),
       exam_scheduled_at = COALESCE(?, exam_scheduled_at),
       exam_status = IF(? IS NOT NULL AND exam_status IN ('not_scheduled', 'cancelled'), 'scheduled', exam_status)
     WHERE id = ?`,
    [
      stage,
      lead.stage,
      why || null,
      CLOSED_STAGES.includes(stage) ? why : null,
      ['new', 'backlog'].includes(lead.stage) && !CLOSED_STAGES.includes(stage) ? toSqlDate(new Date()) : null,
      ticket?.ticket_size ?? null,
      ticket?.ticket_currency ?? null,
      examAt,
      examAt,
      lead.id,
    ]
  )
  await addActivity(lead.id, actor.id, 'status_change', why || null, {
    from: lead.stage,
    to: stage,
    ...(ticket && { ticket_size: ticket.ticket_size, ticket_currency: ticket.ticket_currency }),
  })
  await audit(req, {
    action: reopening ? 'lead.reopen' : 'lead.stage_change',
    targetType: 'lead',
    targetId: lead.id,
    details: { from: lead.stage, to: stage, reason: why || undefined, ...(ticket ?? {}) },
  })
  return getLead(actor, lead.id)
}

// ── Notes, calls, messages ────────────────────────────────────────────────

export const logActivity = async (req, id, { type, body, outcome }) => {
  const actor = req.user
  const lead = await loadVisibleLead(actor, id)
  await addActivity(lead.id, actor.id, type, body?.trim() || null, outcome ? { outcome } : null)
  if (['call', 'message', 'whatsapp', 'email'].includes(type) && !lead.first_contact_at) {
    await pool.query('UPDATE leads SET first_contact_at = UTC_TIMESTAMP() WHERE id = ?', [lead.id])
  }
  return getLead(actor, lead.id)
}

// ── Follow-ups ────────────────────────────────────────────────────────────

const refreshNextFollowUp = (leadId) =>
  pool.query(
    `UPDATE leads SET next_follow_up_at =
       (SELECT MIN(due_at) FROM lead_follow_ups WHERE lead_id = ? AND status = 'pending')
     WHERE id = ?`,
    [leadId, leadId]
  )

export const scheduleFollowUp = async (req, id, { due_at, type, note }) => {
  const actor = req.user
  assertSalesUser(actor)
  const lead = await loadVisibleLead(actor, id)
  if (CLOSED_STAGES.includes(lead.stage)) throw fail(400, 'Reopen this lead before scheduling a follow-up')
  const [r] = await pool.query(
    `INSERT INTO lead_follow_ups (lead_id, owner_id, due_at, type, note, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [lead.id, lead.owner_id ?? actor.id, toSqlDate(due_at), type || 'call', note?.trim() || null, actor.id]
  )
  await refreshNextFollowUp(lead.id)
  await addActivity(lead.id, actor.id, 'follow_up_scheduled', note?.trim() || null, {
    follow_up_id: r.insertId,
    due_at: new Date(due_at).toISOString(),
    type: type || 'call',
  })
  return getLead(actor, lead.id)
}

export const completeFollowUp = async (req, followUpId, { status, outcome }) => {
  const actor = req.user
  assertSalesUser(actor)
  const [[fu]] = await pool.query('SELECT * FROM lead_follow_ups WHERE id = ? LIMIT 1', [followUpId])
  if (!fu) throw fail(404, 'Follow-up not found')
  const lead = await loadVisibleLead(actor, fu.lead_id)
  if (fu.status !== 'pending') throw fail(409, 'This follow-up is already closed')

  await pool.query(
    `UPDATE lead_follow_ups SET status = ?, outcome = ?, completed_at = UTC_TIMESTAMP() WHERE id = ?`,
    [status, outcome?.trim() || null, fu.id]
  )
  await refreshNextFollowUp(lead.id)
  const type = { done: 'follow_up_done', missed: 'follow_up_missed', cancelled: 'follow_up_cancelled' }[status]
  await addActivity(lead.id, actor.id, type, outcome?.trim() || null, { follow_up_id: fu.id, follow_up_type: fu.type })
  if (status === 'done' && !lead.first_contact_at) {
    await pool.query('UPDATE leads SET first_contact_at = UTC_TIMESTAMP() WHERE id = ?', [lead.id])
  }
  return getLead(actor, lead.id)
}

/** Follow-ups due today, overdue or upcoming — own (consultant) or team (admin). */
export const listFollowUps = async (actor, { when = 'today', owner_id } = {}) => {
  assertCrmUser(actor)
  const { start, end } = todayBounds()
  const scope = scopeFor(actor)
  const where = [scope.sql, "f.status = 'pending'", 'l.archived_at IS NULL']
  const values = [...scope.values]
  const add = (sql, ...v) => {
    where.push(sql)
    values.push(...v)
  }
  if (when === 'today') add('f.due_at >= ? AND f.due_at < ?', start, end)
  else if (when === 'overdue') add('f.due_at < ?', start)
  else add('f.due_at >= ?', end)
  if (isManager(actor) && owner_id) add('l.owner_id = ?', owner_id)

  const [rows] = await pool.query(
    `SELECT f.id, f.lead_id, f.due_at, f.type, f.note, l.name AS lead_name, l.phone, l.stage,
            c.title AS course_title, u.name AS owner_name
     FROM lead_follow_ups f
     JOIN leads l ON l.id = f.lead_id
     LEFT JOIN courses c ON c.id = l.course_id
     LEFT JOIN users u ON u.id = l.owner_id
     WHERE ${where.join(' AND ')}
     ORDER BY f.due_at ASC
     LIMIT 200`,
    values
  )
  return rows
}

// ── Read ──────────────────────────────────────────────────────────────────

/** Phone from the lead source: Admins, or the consultant who added the lead by hand. */
const canEditPhone = (actor, lead) => isManager(actor) || (lead.source === 'manual' && lead.created_by === actor?.id)

/** The owner opened the lead: it's no longer new (red dot gone). */
const markSeen = async (actor, lead) => {
  if (lead.owner_id !== actor?.id) return
  const seen = lead.owner_seen_at ? new Date(lead.owner_seen_at).getTime() : 0
  const assigned = lead.assigned_at ? new Date(lead.assigned_at).getTime() : 0
  if (seen && seen >= assigned) return
  await pool.query('UPDATE leads SET owner_seen_at = UTC_TIMESTAMP() WHERE id = ?', [lead.id])
}

/** How many of my leads I haven't opened since they were assigned (tab / menu dot). */
export const newLeadsCount = async (actor) => {
  assertCrmUser(actor)
  const unseen = 'owner_id = ? AND archived_at IS NULL AND (owner_seen_at IS NULL OR owner_seen_at < assigned_at)'
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM leads WHERE ${unseen}`, [actor.id])
  // The most recently assigned one, for "New lead assigned: Asha Rao" on the browser tab
  const [[latest]] = Number(n)
    ? await pool.query(`SELECT id, name FROM leads WHERE ${unseen} ORDER BY assigned_at DESC, id DESC LIMIT 1`, [actor.id])
    : [[null]]
  return { new_leads: Number(n), latest: latest ? { id: latest.id, name: latest.name } : null }
}

export const getLead = async (actor, id) => {
  const lead = await loadVisibleLead(actor, id)
  await markSeen(actor, lead)
  const [[extra]] = await pool.query(
    `SELECT c.title AS course_title, c.slug AS course_slug, o.name AS owner_name, o.email AS owner_email,
            ab.name AS assigned_by_name, s.name AS student_name, s.email AS student_email,
            ec.name AS exam_coordinator_name
     FROM leads l
     LEFT JOIN courses c ON c.id = l.course_id
     LEFT JOIN users o ON o.id = l.owner_id
     LEFT JOIN users ab ON ab.id = l.assigned_by
     LEFT JOIN users s ON s.id = l.user_id
     LEFT JOIN users ec ON ec.id = l.exam_coordinator_id
     WHERE l.id = ?`,
    [lead.id]
  )
  const [activities] = await pool.query(
    `SELECT a.id, a.type, a.body, a.meta, a.created_at, u.name AS actor_name
     FROM lead_activities a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.lead_id = ? ORDER BY a.id DESC LIMIT 200`,
    [lead.id]
  )
  const [followUps] = await pool.query(
    `SELECT id, due_at, type, note, status, outcome, completed_at FROM lead_follow_ups
     WHERE lead_id = ? ORDER BY (status = 'pending') DESC, due_at ASC`,
    [lead.id]
  )
  return {
    ...lead,
    ...extra,
    source_meta: parseJson(lead.source_meta),
    consent: parseJson(lead.consent),
    ...(await studentProgress(lead)),
    allowed_next_stages: allowedNextStages(actor, lead),
    ticket_size: lead.ticket_size == null ? null : Number(lead.ticket_size),
    // What this person may do here (the API enforces the same rules)
    exam_done: Boolean(lead.exam_done),
    application_submitted: Boolean(lead.application_submitted),
    payment_alert: paymentAlert(lead),
    access: {
      edit: canManageLead(actor, lead),
      edit_phone: canManageLead(actor, lead) && canEditPhone(actor, lead),
      assign_exam_coordinator: canManageLead(actor, lead),
      update_application: canManageLead(actor, lead),
      update_exam: true,
      update_payment: true,
      follow_ups: !isCoordinator(actor),
      student_actions: !isCoordinator(actor),
    },
    activities: activities.map((a) => ({ ...a, meta: parseJson(a.meta) })),
    follow_ups: followUps,
  }
}

// Order per tab: red alerts first on Exam Scheduled, soonest exam first; newest payments on Course Done
const ORDER_BY = {
  // Newest lead on top (the "Added" time); follow-ups have their own Due today / Overdue views
  default: 'l.created_at DESC, l.id DESC',
  application: '(l.application_submitted_at IS NULL), l.application_submitted_at DESC, l.stage_changed_at DESC, l.id DESC',
  exam_scheduled: `${PAYMENT_ALERT_SQL} DESC, (l.exam_scheduled_at IS NULL), l.exam_scheduled_at ASC, l.id DESC`,
  course_done: '(l.payment_done_at IS NULL), l.payment_done_at DESC, l.stage_changed_at DESC, l.id DESC',
}

// Quoted list for SQL (fixed constants, never user input)
const DISCUSSION_IN = DISCUSSION_TYPES.map((t) => `'${t}'`).join(', ')
// Optional sort (By consultant view): latest / oldest client discussion first
const SORTS = {
  recent_discussion: '(ld.id IS NULL), ld.id DESC, l.id DESC',
  quiet_first: '(ld.id IS NOT NULL), ld.created_at ASC, l.id DESC',
}

export const listLeads = async (actor, q = {}) => {
  assertCrmUser(actor)
  const scope = scopeFor(actor)
  const where = [scope.sql, 'l.archived_at IS NULL']
  const values = [...scope.values]
  const add = (sql, ...v) => {
    where.push(sql)
    values.push(...v)
  }
  if (q.search) {
    const s = `%${String(q.search).trim()}%`
    const p = normalizePhone(q.search)
    add(`(l.name LIKE ? OR l.email LIKE ?${p ? ' OR l.phone_norm LIKE ?' : ''})`, s, s, ...(p ? [`%${p}%`] : []))
  }
  if (q.source) add('l.source = ?', q.source)
  if (q.course_id) add('l.course_id = ?', q.course_id)
  // Lead added: last 1 / 3 / 7 days, or a custom range of IST dates
  const ADDED_DAYS = { '1d': 1, '3d': 3, '7d': 7 }
  if (ADDED_DAYS[q.added]) add('l.created_at >= ?', toSqlDate(Date.now() - ADDED_DAYS[q.added] * 86400e3))
  const fromDay = q.from && istDayStart(q.from)
  const toDay = q.to && istDayStart(q.to)
  if (fromDay && !isNaN(fromDay)) add('l.created_at >= ?', toSqlDate(fromDay))
  if (toDay && !isNaN(toDay)) add('l.created_at < ?', toSqlDate(toDay.getTime() + 86400e3))
  // Consultant filter: Admins, and coordinators (among their own students)
  if ((isManager(actor) || isCoordinator(actor)) && q.owner_id) {
    if (q.owner_id === 'unassigned') where.push('l.owner_id IS NULL')
    else add('l.owner_id = ?', q.owner_id)
  }
  if (q.follow_up === 'overdue') add('l.next_follow_up_at < UTC_TIMESTAMP()')
  // Coordinator filter: Admins and consultants (among their own leads)
  if (!isCoordinator(actor) && q.exam_coordinator_id) {
    if (q.exam_coordinator_id === 'none') where.push('l.exam_coordinator_id IS NULL')
    else add('l.exam_coordinator_id = ?', q.exam_coordinator_id)
  }
  // ── Advanced filters (Application / Exam Scheduled / Course Done) ──
  const day = (d) => toSqlDate(d)
  const dayEnd = (d) => toSqlDate(new Date(new Date(d).getTime() + 86400e3))
  if (['INR', 'USD'].includes(q.currency)) add('l.ticket_currency = ?', q.currency)
  if (q.ticket_min !== undefined && q.ticket_min !== '') add('l.ticket_size >= ?', Number(q.ticket_min))
  if (q.ticket_max !== undefined && q.ticket_max !== '') add('l.ticket_size <= ?', Number(q.ticket_max))
  if (q.app_submitted === 'yes') where.push('l.application_submitted = 1')
  if (q.app_submitted === 'no') where.push('l.application_submitted = 0')
  if (q.app_from) add('l.application_submitted_at >= ?', day(q.app_from).slice(0, 10))
  if (q.app_to) add('l.application_submitted_at <= ?', day(q.app_to).slice(0, 10))
  if (EXAM_STATUSES.includes(q.exam)) add('l.exam_status = ?', q.exam)
  if (q.exam_done === 'yes') where.push('l.exam_done = 1')
  if (q.exam_done === 'no') where.push('l.exam_done = 0')
  if (q.exam_from) add('l.exam_scheduled_at >= ?', day(q.exam_from))
  if (q.exam_to) add('l.exam_scheduled_at < ?', dayEnd(q.exam_to))
  if (['due', 'done'].includes(q.payment)) add('l.payment_status = ?', q.payment)
  if (q.paid_from) add('l.payment_done_at >= ?', day(q.paid_from))
  if (q.paid_to) add('l.payment_done_at < ?', dayEnd(q.paid_to))
  if (q.alert === '1') where.push(PAYMENT_ALERT_SQL)
  // Only my leads I haven't opened yet (red dot)
  if (q.new === '1') add('l.owner_id = ? AND (l.owner_seen_at IS NULL OR l.owner_seen_at < l.assigned_at)', actor.id)
  // Client discussion: talked in the last 7 days / open and quiet for 7+ days / never
  if (['recent', 'quiet', 'never'].includes(q.contact)) {
    const talked = `EXISTS (SELECT 1 FROM lead_activities da WHERE da.lead_id = l.id AND da.type IN (${DISCUSSION_IN})`
    if (q.contact === 'recent') where.push(`${talked} AND da.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY)`)
    if (q.contact === 'quiet') where.push(`${OPEN_STAGES_SQL} AND NOT ${talked} AND da.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY)`)
    if (q.contact === 'never') where.push(`NOT ${talked})`)
  }

  // Backlog leads live only in the Backlog tab: "All" leaves them out (a search still finds them)
  const ALL_TAB_SQL = "l.stage <> 'backlog'"
  const allTab = !(q.stage && STAGES.includes(q.stage)) && !q.search

  // Admins: every matching lead id (for "select all N" bulk moves)
  if (q.ids_only && isManager(actor)) {
    if (q.stage && STAGES.includes(q.stage)) add('l.stage = ?', q.stage)
    else if (allTab) where.push(ALL_TAB_SQL)
    const [ids] = await pool.query(`SELECT l.id FROM leads l WHERE ${where.join(' AND ')} ORDER BY l.id LIMIT 2000`, values)
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM leads l WHERE ${where.join(' AND ')}`, values)
    return { ids: ids.map((r) => r.id), total: Number(total), capped: Number(total) > ids.length }
  }

  // Stage counts use every filter except the stage itself (for the tabs)
  const [countRows] = await pool.query(
    `SELECT l.stage, COUNT(*) AS n FROM leads l WHERE ${where.join(' AND ')} GROUP BY l.stage`,
    values
  )
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]))
  for (const r of countRows) counts[r.stage] = Number(r.n)

  if (q.stage && STAGES.includes(q.stage)) add('l.stage = ?', q.stage)
  else if (allTab) where.push(ALL_TAB_SQL)
  const page = Math.max(1, Number(q.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 25))
  const [rows] = await pool.query(
    `SELECT l.id, l.name, l.phone, l.email, l.source, l.stage, l.course_id, l.owner_id, l.next_follow_up_at,
            l.created_at, l.stage_changed_at, l.user_id, c.title AS course_title, u.name AS owner_name,
            l.whatsapp_number,
            (l.owner_id = ${Number(actor.id) || 0} AND (l.owner_seen_at IS NULL OR l.owner_seen_at < l.assigned_at)) AS is_new,
            (e.id IS NOT NULL) AS enrolled,
            l.exam_coordinator_id, ec.name AS exam_coordinator_name, l.exam_status, l.exam_scheduled_at,
            l.exam_completed_at, l.exam_result, l.ticket_size, l.ticket_currency,
            l.application_submitted, l.application_submitted_at, l.exam_done, l.payment_status,
            l.payment_done_at, l.payment_reference, ${PAYMENT_ALERT_SQL} AS payment_alert,
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.form_name')), JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.form'))) AS form,
            JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.answers.preferred_time')) AS preferred_time,
            LEFT(JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.answers.message')), 160) AS enquiry_message,
            ld.type AS last_discussion_type, LEFT(ld.body, 240) AS last_discussion,
            ld.created_at AS last_discussion_at, ldu.name AS last_discussion_by
     FROM leads l
     LEFT JOIN courses c ON c.id = l.course_id
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN users ec ON ec.id = l.exam_coordinator_id
     LEFT JOIN enrollments e ON e.user_id = l.user_id AND e.course_id = l.course_id
     LEFT JOIN lead_activities ld ON ld.id = (
       SELECT MAX(a.id) FROM lead_activities a WHERE a.lead_id = l.id AND a.type IN (${DISCUSSION_IN}))
     LEFT JOIN users ldu ON ldu.id = ld.actor_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${SORTS[q.sort] ?? ORDER_BY[q.stage] ?? ORDER_BY.default}
     LIMIT ? OFFSET ?`,
    [...values, limit, (page - 1) * limit]
  )
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM leads l WHERE ${where.join(' AND ')}`, values)
  return {
    leads: rows.map((r) => ({
      ...r,
      enrolled: Boolean(r.enrolled),
      is_new: Boolean(r.is_new),
      ticket_size: r.ticket_size == null ? null : Number(r.ticket_size),
      application_submitted: Boolean(r.application_submitted),
      exam_done: Boolean(r.exam_done),
      payment_alert: Boolean(r.payment_alert),
    })),
    counts,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  }
}

/**
 * Leads whose ticket size counts as earned: Payment Done (or a confirmed online
 * payment), or the lead reached Course Done. earned_at = whichever came first.
 */
export const TICKET_EARNED_SQL = `
  SELECT l.id, l.owner_id, l.ticket_currency AS currency, l.ticket_size AS amount,
         LEAST(
           COALESCE(l.payment_done_at, '9999-12-31'),
           COALESCE((SELECT MIN(p.created_at) FROM payments p WHERE p.lead_id = l.id AND p.status = 'success'), '9999-12-31'),
           CASE WHEN l.stage = 'course_done' THEN COALESCE(l.stage_changed_at, l.updated_at, l.created_at) ELSE '9999-12-31' END
         ) AS earned_at,
         (l.payment_status = 'done' OR EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = l.id AND p.status = 'success')) AS paid,
         (l.stage = 'course_done') AS course_done
  FROM leads l
  WHERE l.archived_at IS NULL AND l.ticket_size IS NOT NULL
    AND (l.stage = 'course_done' OR l.payment_status = 'done'
         OR EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = l.id AND p.status = 'success'))`

/** KPI row and today's work (PRD §4.1). Sales/revenue arrive with phase 5. */
export const dashboard = async (actor) => {
  assertCrmUser(actor)
  const scope = scopeFor(actor)
  const { start, end } = todayBounds()
  const [[k]] = await pool.query(
    `SELECT
       SUM(l.stage NOT IN ('backlog','not_interested','junk','course_done')) AS open_leads, -- backlog is counted on its own
       SUM(l.stage = 'new') AS new_leads,
       SUM(l.stage = 'backlog') AS backlog,
       SUM(l.stage = 'in_conversation') AS in_conversation,
       SUM(l.stage = 'application') AS applications,
       SUM(l.stage = 'exam_scheduled') AS exam_scheduled,
       SUM(l.stage = 'course_done') AS course_done,
       COUNT(*) AS total_leads
     FROM leads l WHERE ${scope.sql} AND l.archived_at IS NULL`,
    scope.values
  )
  const [[f]] = await pool.query(
    `SELECT SUM(f.due_at >= ? AND f.due_at < ?) AS due_today, SUM(f.due_at < ?) AS overdue
     FROM lead_follow_ups f JOIN leads l ON l.id = f.lead_id
     WHERE ${scope.sql} AND f.status = 'pending' AND l.archived_at IS NULL`,
    [start, end, start, ...scope.values]
  )
  const [[en]] = await pool.query(
    `SELECT COUNT(DISTINCT l.id) AS enrolled FROM leads l
     JOIN enrollments e ON e.user_id = l.user_id AND e.course_id = l.course_id
     WHERE ${scope.sql} AND l.archived_at IS NULL`,
    scope.values
  )
  const [[ex]] = await pool.query(
    `SELECT
       SUM(l.exam_status IN ('scheduled', 'rescheduled') AND l.exam_done = 0) AS exams_scheduled,
       SUM(l.exam_status IN ('scheduled', 'rescheduled') AND l.exam_done = 0 AND l.exam_scheduled_at >= UTC_TIMESTAMP()
           AND l.exam_scheduled_at < UTC_TIMESTAMP() + INTERVAL 7 DAY) AS exams_next_7_days,
       SUM(l.exam_done = 1) AS exams_completed,
       SUM(l.exam_done = 1 AND l.exam_completed_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')) AS exams_completed_this_month,
       SUM(l.exam_result = 'passed') AS exams_passed,
       SUM(${PAYMENT_ALERT_SQL}) AS payment_alerts,
       SUM(l.payment_status = 'done' AND l.payment_done_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')) AS payments_this_month,
       SUM(l.stage IN ('application', 'exam_scheduled')) AS in_exam_pipeline
     FROM leads l WHERE ${scope.sql} AND l.archived_at IS NULL`,
    scope.values
  )
  const [tickets] = await pool.query(
    `SELECT l.ticket_currency AS currency, COUNT(*) AS leads, SUM(l.ticket_size) AS amount
     FROM leads l WHERE ${scope.sql} AND l.archived_at IS NULL AND l.stage = 'application' AND l.ticket_size IS NOT NULL
     GROUP BY l.ticket_currency`,
    scope.values
  )
  const [upcomingExams] = await pool.query(
    `SELECT l.id, l.name, l.exam_scheduled_at, c.title AS course_title, u.name AS owner_name, ec.name AS exam_coordinator_name
     FROM leads l
     LEFT JOIN courses c ON c.id = l.course_id
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN users ec ON ec.id = l.exam_coordinator_id
     WHERE ${scope.sql} AND l.archived_at IS NULL AND l.exam_status IN ('scheduled', 'rescheduled') AND l.exam_done = 0
       AND l.stage NOT IN ('course_done', 'not_interested', 'junk')
     ORDER BY (l.exam_scheduled_at IS NULL), l.exam_scheduled_at ASC LIMIT 20`,
    scope.values
  )
  const num = (v) => Number(v ?? 0)
  const isSuper = actor.role === 'super_admin'
  // Revenue by ticket size: leads that paid or reached Course Done (Super Admins only)
  let ticketRevenue = null
  if (isSuper) {
    const [rows] = await pool.query(
      `SELECT t.currency, COUNT(*) AS leads, SUM(t.amount) AS amount,
              SUM(CASE WHEN t.earned_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01') THEN t.amount ELSE 0 END) AS this_month
       FROM (${TICKET_EARNED_SQL}) t GROUP BY t.currency`
    )
    ticketRevenue = rows.map((r) => ({
      currency: r.currency,
      leads: num(r.leads),
      amount: Number(r.amount ?? 0),
      this_month: Number(r.this_month ?? 0),
    }))
  }
  return {
    money_visible: isSuper,
    ticket_revenue: ticketRevenue,
    exams: {
      scheduled: num(ex.exams_scheduled),
      next_7_days: num(ex.exams_next_7_days),
      completed: num(ex.exams_completed),
      completed_this_month: num(ex.exams_completed_this_month),
      passed: num(ex.exams_passed),
      payment_alerts: num(ex.payment_alerts),
      payments_this_month: num(ex.payments_this_month),
      upcoming: upcomingExams,
    },
    // Open applications by currency (expected value)
    pipeline: isSuper ? tickets.map((t) => ({ currency: t.currency, leads: num(t.leads), amount: Number(t.amount ?? 0) })) : null,
    kpis: {
      open_leads: num(k.open_leads),
      new_leads: num(k.new_leads),
      backlog: num(k.backlog),
      follow_ups_today: num(f.due_today),
      overdue_follow_ups: num(f.overdue),
      in_conversation: num(k.in_conversation),
      applications: num(k.applications),
      exam_scheduled: num(k.exam_scheduled),
      enrolled_students: num(en.enrolled),
      course_done: num(k.course_done),
      total_leads: num(k.total_leads),
    },
    today: await listFollowUps(actor, { when: 'today' }),
    overdue: (await listFollowUps(actor, { when: 'overdue' })).slice(0, 20),
  }
}

// ── Exam coordination ─────────────────────────────────────────────────────

/** Active Exam Coordinators (for the "Exam coordinator" picker). */
export const examCoordinators = async (actor) => {
  assertSalesUser(actor)
  const [rows] = await pool.query(
    `SELECT u.id, u.name,
            (SELECT COUNT(*) FROM leads l WHERE l.exam_coordinator_id = u.id AND l.archived_at IS NULL
               AND l.stage NOT IN ('course_done', 'not_interested', 'junk')) AS open_exams
     FROM users u WHERE u.role = ? AND u.is_active = 1 AND u.deleted_at IS NULL ORDER BY u.name`,
    [COORDINATOR]
  )
  return rows.map((r) => ({ ...r, open_exams: Number(r.open_exams) }))
}

/** Owner or Admin hands the lead to an Exam Coordinator (or removes them). The owner stays. */
export const setExamCoordinator = async (req, id, { exam_coordinator_id }) => {
  const actor = req.user
  assertSalesUser(actor)
  const lead = await loadVisibleLead(actor, id)
  if (!canManageLead(actor, lead)) throw fail(403, "Only the lead's consultant or an Admin can assign the exam coordinator")
  const to = exam_coordinator_id ?? null
  if (to === lead.exam_coordinator_id) return getLead(actor, lead.id)
  if (to != null) {
    const [[u]] = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = ? AND deleted_at IS NULL', [to])
    if (!u || !u.is_active || u.role !== COORDINATOR) throw fail(400, 'Choose an active exam coordinator')
  }
  await pool.query('UPDATE leads SET exam_coordinator_id = ?, exam_coordinator_assigned_at = ? WHERE id = ?', [
    to,
    to ? toSqlDate(new Date()) : null,
    lead.id,
  ])
  await addActivity(lead.id, actor.id, 'exam_coordinator', null, { from: lead.exam_coordinator_id ?? null, to })
  await audit(req, {
    action: 'lead.exam_coordinator',
    targetType: 'lead',
    targetId: lead.id,
    details: { from: lead.exam_coordinator_id ?? null, to },
  })
  if (to) {
    await notify(to, {
      type: 'exam_assigned',
      title: `New student for exam: ${lead.name}`,
      body: `Assigned by ${actor.name ?? 'a team member'}`,
      link: `/consultant/leads?lead=${lead.id}`,
    })
  }
  return getLead(actor, lead.id)
}

/** Who else should hear about a change on this lead (owner and coordinator, not the actor). */
const otherSide = (lead, actor) => [lead.owner_id, lead.exam_coordinator_id].filter((u) => u && u !== actor.id)

/**
 * Anyone with access to the lead: the exam schedule (Scheduled / Rescheduled /
 * Cancelled, with date and time) and Exam Done (yes/no). Scheduling the exam
 * moves an Application lead to Exam Scheduled.
 */
/**
 * Schedule, move or cancel the exam (Exam Coordinator, the lead's consultant or an Admin).
 *   • Scheduling an Application lead moves it to Exam Scheduled.
 *   • Changing the date of a scheduled exam is a reschedule (old date kept in the timeline).
 *   • Cancelling needs a remark, keeps the scheduled date on record and moves an
 *     Exam Scheduled lead back to Application.
 *   • "Exam done" is not set by hand: it turns on by itself once the exam time has
 *     passed (markExamsTaken), which raises the payment-due alert.
 */
export const updateExam = async (req, id, { status, scheduled_at, note }) => {
  const actor = req.user
  const lead = await loadVisibleLead(actor, id)
  if (!EXAM_STATUSES.includes(status)) throw fail(400, 'Unknown exam status')
  if (['course_done', ...CLOSED_STAGES].includes(lead.stage) && !isManager(actor)) {
    throw fail(409, `This lead is in ${STAGE_LABELS[lead.stage]}; ask an Admin to change the exam`)
  }
  const remark = note?.trim() || null
  const prevAt = lead.exam_scheduled_at ? toSqlDate(lead.exam_scheduled_at) : null
  const wasLive = ['scheduled', 'rescheduled'].includes(lead.exam_status)

  // ── Cancel ──
  if (status === 'cancelled') {
    if (!remark) throw fail(400, 'Add a remark: why was the exam cancelled?')
    if (lead.exam_status === 'cancelled') throw fail(409, 'This exam is already cancelled')
    await pool.query(
      `UPDATE leads SET exam_status = 'cancelled', exam_done = 0, exam_completed_at = NULL, exam_result = NULL, exam_note = ?
       WHERE id = ?`,
      [remark, lead.id]
    )
    await addActivity(lead.id, actor.id, 'exam_cancelled', remark, {
      status,
      ...(prevAt && { scheduled_at: sqlToIso(prevAt) }), // the date it was booked for, kept on record
    })
    await audit(req, { action: 'lead.exam_cancelled', targetType: 'lead', targetId: lead.id, details: { scheduled_at: prevAt, remark } })
    const backToApplication = lead.stage === 'exam_scheduled'
    if (backToApplication) await moveStageFor(lead, actor, 'application', `Exam cancelled: ${remark}`)
    const others = otherSide(lead, actor)
    if (others.length) {
      await notify(others, {
        type: 'exam_schedule',
        title: `${lead.name}: exam cancelled${backToApplication ? ' — back to Application' : ''}`,
        body: `${prevAt ? `Was on ${fmtIst(sqlToIso(prevAt))}. ` : ''}Remark: ${remark}`,
        link: `/consultant/leads?lead=${lead.id}`,
      })
    }
    return getLead(actor, lead.id)
  }

  // ── Clear (no exam) ──
  if (status === 'not_scheduled') {
    await pool.query(
      `UPDATE leads SET exam_status = 'not_scheduled', exam_scheduled_at = NULL, exam_done = 0, exam_completed_at = NULL,
              exam_result = NULL, exam_note = ? WHERE id = ?`,
      [remark, lead.id]
    )
    await addActivity(lead.id, actor.id, 'exam_cleared', remark, { status, ...(prevAt && { previous_at: sqlToIso(prevAt) }) })
    await audit(req, { action: 'lead.exam_cleared', targetType: 'lead', targetId: lead.id })
    return getLead(actor, lead.id)
  }

  // ── Schedule / move the date ──
  const at = scheduled_at ? toSqlDate(scheduled_at) : prevAt
  if (!at) throw fail(400, 'Choose the exam date and time')
  const moved = Boolean(wasLive && prevAt && at !== prevAt)
  // A new date on a live exam is a reschedule; booking again after a cancel is a fresh schedule
  const nextStatus = moved || (lead.exam_status === 'rescheduled' && wasLive) ? 'rescheduled' : 'scheduled'
  // A date in the future means the exam hasn't been taken yet
  const future = new Date(sqlToIso(at)).getTime() > Date.now()
  const done = future ? false : Boolean(lead.exam_done) && !moved
  await pool.query(
    `UPDATE leads SET exam_status = ?, exam_scheduled_at = ?, exam_done = ?, exam_completed_at = ?, exam_note = ?
     WHERE id = ?`,
    [nextStatus, at, done ? 1 : 0, done ? toSqlDate(lead.exam_completed_at || sqlToIso(at)) : null, remark ?? lead.exam_note ?? null, lead.id]
  )
  const type = moved ? 'exam_rescheduled' : 'exam_scheduled'
  if (moved || !wasLive || remark !== (lead.exam_note || null)) {
    await addActivity(lead.id, actor.id, type, remark, {
      status: nextStatus,
      scheduled_at: sqlToIso(at),
      ...(moved && { previous_at: sqlToIso(prevAt) }),
    })
  }
  await audit(req, { action: `lead.${type}`, targetType: 'lead', targetId: lead.id, details: { from: prevAt, to: at } })

  // Application → Exam Scheduled once the exam has a date
  if (lead.stage === 'application') await moveStageFor(lead, actor, 'exam_scheduled', 'Exam scheduled')

  const others = otherSide(lead, actor)
  if (others.length && (moved || !wasLive)) {
    await notify(others, {
      type: 'exam_schedule',
      title: `${lead.name}: exam ${moved ? 'rescheduled' : 'scheduled'}`,
      body: `On ${fmtIst(sqlToIso(at))}${moved ? ` (was ${fmtIst(sqlToIso(prevAt))})` : ''}`,
      link: `/consultant/leads?lead=${lead.id}`,
    })
  }
  return getLead(actor, lead.id)
}

/**
 * Exams whose date and time have passed count as done (no Yes/No to click).
 * Runs every 5 minutes from the CRM scheduler; tells the consultant and the
 * coordinator, with "payment due" when the payment isn't in yet.
 */
export const markExamsTaken = async () => {
  const [rows] = await pool.query(
    `SELECT l.id, l.name, l.owner_id, l.exam_coordinator_id, l.exam_scheduled_at, l.payment_status
     FROM leads l
     WHERE l.exam_done = 0 AND l.exam_status IN ('scheduled', 'rescheduled') AND l.exam_scheduled_at <= UTC_TIMESTAMP()
       AND l.archived_at IS NULL AND l.stage NOT IN ('not_interested', 'junk')
     LIMIT 500`
  )
  let marked = 0
  for (const l of rows) {
    const [claim] = await pool.query(
      `UPDATE leads SET exam_done = 1, exam_completed_at = exam_scheduled_at
       WHERE id = ? AND exam_done = 0 AND exam_status IN ('scheduled', 'rescheduled') AND exam_scheduled_at <= UTC_TIMESTAMP()`,
      [l.id]
    )
    if (!claim.affectedRows) continue
    marked++
    await addActivity(l.id, null, 'exam_completed', null, { automatic: true, completed_at: sqlToIso(toSqlDate(l.exam_scheduled_at)) })
    const unpaid = l.payment_status !== 'done'
    const to = [l.owner_id, l.exam_coordinator_id].filter(Boolean)
    const message = {
      type: unpaid ? 'payment_due' : 'exam_completed',
      title: `${l.name}: exam done${unpaid ? ' — payment due' : ''}`,
      body: unpaid ? 'The exam time has passed and the payment is still due' : 'The exam time has passed; payment already received',
    }
    if (to.length) await notify(to, { ...message, link: `/consultant/leads?lead=${l.id}` })
    else await notify(await managerIds(), { ...message, link: `/admin/leads?lead=${l.id}` })
  }
  return marked
}

/** Consultant (owner) or Admin: Application Submitted yes/no and its date. */
export const updateApplication = async (req, id, { submitted, submitted_at }) => {
  const actor = req.user
  assertSalesUser(actor)
  const lead = await loadVisibleLead(actor, id)
  if (!canManageLead(actor, lead)) throw fail(403, "Only the lead's consultant or an Admin can update the application")
  const date = submitted ? (submitted_at ? new Date(submitted_at) : new Date()).toISOString().slice(0, 10) : null
  await pool.query('UPDATE leads SET application_submitted = ?, application_submitted_at = ? WHERE id = ?', [submitted ? 1 : 0, date, lead.id])
  await addActivity(lead.id, actor.id, 'application_update', null, { submitted: Boolean(submitted), submitted_at: date })
  await audit(req, { action: 'lead.application', targetType: 'lead', targetId: lead.id, details: { submitted: Boolean(submitted), date } })
  return getLead(actor, lead.id)
}

/**
 * Anyone with access: Payment Due ↔ Payment Done. Payment Done moves the lead
 * to Course Done; setting it back to Due moves a Course Done lead back to
 * Exam Scheduled.
 */
export const updatePayment = async (req, id, { status, paid_at, reference }) => {
  const actor = req.user
  const lead = await loadVisibleLead(actor, id)
  if (!['due', 'done'].includes(status)) throw fail(400, 'Choose Payment Due or Payment Done')
  if (CLOSED_STAGES.includes(lead.stage)) throw fail(409, `Reopen this lead first (it's ${STAGE_LABELS[lead.stage]})`)
  const done = status === 'done'
  const paidAt = done ? toSqlDate(paid_at || lead.payment_done_at || new Date()) : null
  const ref = done ? (reference !== undefined ? reference?.trim() || null : lead.payment_reference) : null
  await pool.query(
    'UPDATE leads SET payment_status = ?, payment_done_at = ?, payment_reference = ?, payment_marked_by = ? WHERE id = ?',
    [status, paidAt, ref, done ? actor.id : null, lead.id]
  )
  await addActivity(lead.id, actor.id, done ? 'payment_done' : 'payment_due', null, {
    ...(paidAt && { paid_at: sqlToIso(paidAt) }),
    ...(ref && { reference: ref }),
  })
  await audit(req, { action: done ? 'lead.payment_done' : 'lead.payment_due', targetType: 'lead', targetId: lead.id, details: { reference: ref } })

  if (done && lead.stage !== 'course_done' && PAYMENT_TO_COURSE_DONE.includes(lead.stage)) {
    await moveStageFor(lead, actor, 'course_done', 'Payment done')
    const others = otherSide(lead, actor)
    if (others.length) {
      await notify(others, {
        type: 'course_done',
        title: `${lead.name}: payment done → Course Done`,
        body: `Marked by ${actor.name ?? 'a team member'}`,
        link: `/consultant/leads?lead=${lead.id}`,
      })
    }
  }
  if (!done && lead.stage === 'course_done') {
    await moveStageFor(lead, actor, ['scheduled', 'rescheduled'].includes(lead.exam_status) ? 'exam_scheduled' : 'application', 'Payment set back to due')
  }
  return getLead(actor, lead.id)
}

/**
 * Admin → By consultant: every consultant (and anyone else who owns leads) with
 * their leads per stage and how actively the leads are being worked.
 */
export const consultantProgress = async (actor) => {
  if (!isManager(actor)) throw fail(403, 'Only Admins see the team')
  const { start, end } = todayBounds()
  const [people] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.is_active,
            (cs.on_leave_until >= CURDATE() AND (cs.on_leave_from IS NULL OR cs.on_leave_from <= CURDATE())) AS on_leave,
            cs.on_leave_until
     FROM users u LEFT JOIN consultant_settings cs ON cs.user_id = u.id
     WHERE u.deleted_at IS NULL
       AND (u.role = 'consultant' OR u.id IN (SELECT DISTINCT owner_id FROM leads WHERE archived_at IS NULL AND owner_id IS NOT NULL))
     ORDER BY u.is_active DESC, FIELD(u.role, 'consultant') DESC, u.name`
  )
  const [stageRows] = await pool.query(
    `SELECT l.owner_id, l.stage, COUNT(*) AS n FROM leads l
     WHERE l.archived_at IS NULL AND l.owner_id IS NOT NULL GROUP BY l.owner_id, l.stage`
  )
  const [sumRows] = await pool.query(
    `SELECT l.owner_id,
            SUM(${OPEN_STAGES_SQL}) AS open,
            SUM(${OPEN_STAGES_SQL} AND l.next_follow_up_at < ?) AS overdue,
            SUM(${OPEN_STAGES_SQL} AND l.next_follow_up_at >= ? AND l.next_follow_up_at < ?) AS due_today,
            SUM(${OPEN_STAGES_SQL} AND l.next_follow_up_at IS NULL) AS no_follow_up,
            SUM(${PAYMENT_ALERT_SQL}) AS payment_alerts,
            SUM(l.stage = 'course_done' AND l.stage_changed_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')) AS done_this_month,
            SUM(${OPEN_STAGES_SQL} AND NOT EXISTS (
              SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id AND a.type IN (${DISCUSSION_IN})
                AND a.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY)) AS quiet_7d,
            SUM(NOT EXISTS (SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id AND a.type IN (${DISCUSSION_IN}))) AS never_discussed
     FROM leads l WHERE l.archived_at IS NULL AND l.owner_id IS NOT NULL GROUP BY l.owner_id`,
    [start, start, end]
  )
  const [talkRows] = await pool.query(
    `SELECT l.owner_id,
            COUNT(DISTINCT CASE WHEN a.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY THEN a.lead_id END) AS discussed_7d,
            SUM(a.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY) AS discussions_7d,
            MAX(a.created_at) AS last_discussion_at
     FROM lead_activities a JOIN leads l ON l.id = a.lead_id
     WHERE l.archived_at IS NULL AND l.owner_id IS NOT NULL AND a.type IN (${DISCUSSION_IN})
     GROUP BY l.owner_id`
  )
  const n = (v) => Number(v ?? 0)
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.owner_id, r]))
  const sums = by(sumRows)
  const talk = by(talkRows)
  const stagesOf = {}
  for (const r of stageRows) (stagesOf[r.owner_id] ??= Object.fromEntries(STAGES.map((s) => [s, 0])))[r.stage] = n(r.n)

  const consultants = people.map((p) => {
    const stages = stagesOf[p.id] ?? Object.fromEntries(STAGES.map((s) => [s, 0]))
    const total = Object.values(stages).reduce((a, b) => a + b, 0)
    const s = sums[p.id] ?? {}
    const t = talk[p.id] ?? {}
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      is_active: Boolean(p.is_active),
      on_leave: Boolean(p.on_leave),
      on_leave_until: p.on_leave_until,
      total,
      stages,
      open: n(s.open),
      overdue: n(s.overdue),
      due_today: n(s.due_today),
      no_follow_up: n(s.no_follow_up),
      payment_alerts: n(s.payment_alerts),
      done_this_month: n(s.done_this_month),
      quiet_7d: n(s.quiet_7d),
      never_discussed: n(s.never_discussed),
      discussed_7d: n(t.discussed_7d),
      discussions_7d: n(t.discussions_7d),
      last_discussion_at: t.last_discussion_at ?? null,
      conversion: total ? Math.round((stages.course_done / total) * 1000) / 10 : 0,
    }
  })
  // Leads nobody owns, so they don't slip through
  const [[{ unassigned }]] = await pool.query(
    'SELECT COUNT(*) AS unassigned FROM leads WHERE archived_at IS NULL AND owner_id IS NULL'
  )
  return { consultants, unassigned: n(unassigned) }
}

/**
 * Super Admin only: delete leads for good, after re-entering their password.
 * Their timeline, follow-ups and WhatsApp messages go with them; payments,
 * enrollments, certificates, discount links and batch enrollments stay but
 * are unlinked. The audit log keeps who deleted what.
 */
export const deleteLeads = async (req, { lead_ids, password }) => {
  const actor = req.user
  if (actor?.role !== 'super_admin') {
    await audit(req, { action: 'lead.delete', targetType: 'lead', result: 'denied', details: { count: lead_ids?.length } })
    throw fail(403, 'Only a Super Admin can delete leads')
  }
  await reauthenticate(actor, password)
  const ids = [...new Set((lead_ids ?? []).map(Number).filter(Boolean))]
  const [rows] = await pool.query('SELECT id, name, email, phone, stage, owner_id FROM leads WHERE id IN (?)', [ids])
  if (!rows.length) throw fail(404, 'Those leads were not found')
  const found = rows.map((r) => r.id)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const run = async (sql) => {
      try {
        await conn.query(sql, [found])
      } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err
      }
    }
    await run('DELETE FROM lead_activities WHERE lead_id IN (?)')
    await run('DELETE FROM lead_follow_ups WHERE lead_id IN (?)')
    await run('DELETE FROM whatsapp_messages WHERE lead_id IN (?)')
    for (const t of ['lead_ingest_events', 'batch_enrollments', 'payments', 'discount_links', 'enrollments', 'certificates']) {
      await run(`UPDATE ${t} SET lead_id = NULL WHERE lead_id IN (?)`)
    }
    await conn.query('DELETE FROM leads WHERE id IN (?)', [found])
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  await audit(req, {
    action: 'lead.delete',
    targetType: 'lead',
    targetId: found.length === 1 ? found[0] : null,
    details: { count: found.length, leads: rows.slice(0, 200).map((r) => ({ id: r.id, name: r.name, stage: r.stage, owner_id: r.owner_id })) },
  })
  return { deleted: found.length, ids: found }
}

/** People a lead can be assigned to (Admin create form). */
export const assignableOwners = async (actor) => {
  // Coordinators get the consultants' names, for the "Consultant" filter on their students
  if (isCoordinator(actor)) {
    const [rows] = await pool.query(
      "SELECT u.id, u.name, u.role FROM users u WHERE u.role = 'consultant' AND u.is_active = 1 AND u.deleted_at IS NULL ORDER BY u.name"
    )
    return rows
  }
  if (!isManager(actor)) throw fail(403, 'Only Admins assign leads')
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.role, cs.accepting_leads,
            (cs.on_leave_until >= CURDATE() AND (cs.on_leave_from IS NULL OR cs.on_leave_from <= CURDATE())) AS on_leave,
            cs.on_leave_until
     FROM users u LEFT JOIN consultant_settings cs ON cs.user_id = u.id
     WHERE u.is_active = 1 AND u.deleted_at IS NULL AND u.role IN ('consultant', 'admin', 'super_admin')
     ORDER BY FIELD(u.role, 'consultant', 'admin', 'super_admin'), u.name`
  )
  return rows.map((r) => ({ ...r, on_leave: Boolean(r.on_leave) }))
}
