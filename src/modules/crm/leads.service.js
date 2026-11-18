// src/modules/crm/leads.service.js
// 2.0 Phase 3 — lead records, pipeline, activity timeline and follow-ups
// (PRD §4–§5). Access is enforced here, not in the UI:
//   • Consultants see and work only leads they own.
//   • Exam Coordinators see the leads assigned to them for the exam: they log
//     notes, update the exam and, once it is completed, mark Course Done.
//     The lead stays owned by its consultant.
//   • Admins and Super Admins see all leads.
//   • Moving to Application records the ticket size (INR or USD).
//   • Closed leads (Not Interested / Junk) reopen only with a reason, by an Admin.
//   • "Course Done" is set by the team whenever they decide (no account, course
//     or progress check). The auto_course_done automation still moves a lead
//     there when its student completes the course. Enrollment and course
//     progress are tracked separately; certificates still need completion.

import { pool } from '../../config/db.js'
import { managerIds, notify } from '../../utils/notify.js'
import env from '../../config/env.js'
import { audit } from '../../utils/audit.js'
import { getCompletionStatus } from '../certificates/certificates.service.js'
import { autoAssign } from './distribution.service.js'
import {
  CLOSED_STAGES,
  EXAM_STATUSES,
  REASON_REQUIRED,
  STAGE_LABELS,
  STAGES,
  TICKET_CURRENCIES,
  TRANSITIONS,
} from './crm.constants.js'

const fail = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra)
const MANAGERS = ['super_admin', 'admin']
const isManager = (actor) => MANAGERS.includes(actor?.role)
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
  const next = {
    name: body.name ?? lead.name,
    phone: body.phone !== undefined ? body.phone || null : lead.phone,
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
    `UPDATE leads SET name = ?, phone = ?, phone_norm = ?, email = ?, email_norm = ?, course_id = ?,
       preferred_schedule = ?, ticket_size = ?, ticket_currency = ?, user_id = COALESCE(user_id, ?) WHERE id = ?`,
    [
      next.name,
      next.phone,
      normalizePhone(next.phone),
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

/** Once the exam is completed, Course Done is open from any open stage. */
const examDone = (lead) => lead.exam_status === 'completed'
const canMarkCourseDone = (lead) =>
  examDone(lead) && lead.stage !== 'course_done' && !CLOSED_STAGES.includes(lead.stage)

/** Stages this actor may move the lead to now. */
const allowedNextStages = (actor, lead) => {
  if (isCoordinator(actor)) return canMarkCourseDone(lead) ? ['course_done'] : []
  if (!canManageLead(actor, lead)) return []
  const next = (TRANSITIONS[lead.stage] ?? []).filter((s) => !CLOSED_STAGES.includes(lead.stage) || isManager(actor))
  if (canMarkCourseDone(lead) && !next.includes('course_done')) next.push('course_done')
  return next
}

export const changeStage = async (req, id, { stage, reason, ticket_size, ticket_currency }) => {
  const actor = req.user
  const lead = await loadVisibleLead(actor, id)
  if (!STAGES.includes(stage)) throw fail(400, 'Unknown stage')
  if (stage === lead.stage) throw fail(409, `This lead is already in ${STAGE_LABELS[stage]}`)
  // Exam Coordinators: only Course Done, and only after the exam is completed
  if (isCoordinator(actor) && !(stage === 'course_done' && canMarkCourseDone(lead))) {
    throw fail(403, 'Exam coordinators can mark Course Done once the exam is completed')
  }
  if (!isCoordinator(actor) && !canManageLead(actor, lead)) throw fail(403, "You can't change this lead's status")
  const examRoute = stage === 'course_done' && canMarkCourseDone(lead)

  const reopening = CLOSED_STAGES.includes(lead.stage)
  if (reopening && !isManager(actor)) {
    await audit(req, { action: 'lead.reopen', targetType: 'lead', targetId: lead.id, result: 'denied', details: { from: lead.stage, to: stage } })
    throw fail(403, 'Only an Admin can reopen a closed lead')
  }
  if (!examRoute && !(TRANSITIONS[lead.stage] ?? []).includes(stage)) {
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

  await pool.query(
    `UPDATE leads SET stage = ?, prior_stage = ?, stage_reason = ?, stage_changed_at = UTC_TIMESTAMP(),
       disposition_reason = ?, first_contact_at = COALESCE(first_contact_at, ?),
       ticket_size = COALESCE(?, ticket_size), ticket_currency = COALESCE(?, ticket_currency)
     WHERE id = ?`,
    [
      stage,
      lead.stage,
      why || null,
      CLOSED_STAGES.includes(stage) ? why : null,
      lead.stage === 'new' && !CLOSED_STAGES.includes(stage) ? toSqlDate(new Date()) : null,
      ticket?.ticket_size ?? null,
      ticket?.ticket_currency ?? null,
      lead.id,
    ]
  )
  await addActivity(lead.id, actor.id, 'status_change', why || null, {
    from: lead.stage,
    to: stage,
    ...(ticket && { ticket_size: ticket.ticket_size, ticket_currency: ticket.ticket_currency }),
  })
  // The other side of the lead hears about Course Done
  if (stage === 'course_done') {
    const others = [lead.owner_id, lead.exam_coordinator_id].filter((u) => u && u !== actor.id)
    await notify(others, {
      type: 'course_done',
      title: `${lead.name}: Course Done`,
      body: `Marked by ${actor.name ?? 'a team member'}`,
      link: `/consultant/leads?lead=${lead.id}`,
    })
  }
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

export const getLead = async (actor, id) => {
  const lead = await loadVisibleLead(actor, id)
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
    access: {
      edit: canManageLead(actor, lead),
      assign_exam_coordinator: canManageLead(actor, lead),
      update_exam: true,
      follow_ups: !isCoordinator(actor),
      student_actions: !isCoordinator(actor),
      course_done: canMarkCourseDone(lead) && (isCoordinator(actor) || canManageLead(actor, lead)),
    },
    activities: activities.map((a) => ({ ...a, meta: parseJson(a.meta) })),
    follow_ups: followUps,
  }
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
  if (q.from) add('l.created_at >= ?', toSqlDate(q.from))
  if (q.to) add('l.created_at < ?', toSqlDate(new Date(new Date(q.to).getTime() + 86400e3)))
  if (isManager(actor) && q.owner_id) {
    if (q.owner_id === 'unassigned') where.push('l.owner_id IS NULL')
    else add('l.owner_id = ?', q.owner_id)
  }
  if (q.follow_up === 'overdue') add('l.next_follow_up_at < UTC_TIMESTAMP()')
  if (EXAM_STATUSES.includes(q.exam)) add('l.exam_status = ?', q.exam)
  if (isManager(actor) && q.exam_coordinator_id) {
    if (q.exam_coordinator_id === 'none') where.push('l.exam_coordinator_id IS NULL')
    else add('l.exam_coordinator_id = ?', q.exam_coordinator_id)
  }

  // Admins: every matching lead id (for "select all N" bulk moves)
  if (q.ids_only && isManager(actor)) {
    if (q.stage && STAGES.includes(q.stage)) add('l.stage = ?', q.stage)
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
  const page = Math.max(1, Number(q.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 25))
  const [rows] = await pool.query(
    `SELECT l.id, l.name, l.phone, l.email, l.source, l.stage, l.course_id, l.owner_id, l.next_follow_up_at,
            l.created_at, l.stage_changed_at, l.user_id, c.title AS course_title, u.name AS owner_name,
            (e.id IS NOT NULL) AS enrolled,
            l.exam_coordinator_id, ec.name AS exam_coordinator_name, l.exam_status, l.exam_scheduled_at,
            l.exam_completed_at, l.exam_result, l.ticket_size, l.ticket_currency,
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.form_name')), JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.form'))) AS form,
            JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.answers.preferred_time')) AS preferred_time,
            LEFT(JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.answers.message')), 160) AS enquiry_message
     FROM leads l
     LEFT JOIN courses c ON c.id = l.course_id
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN users ec ON ec.id = l.exam_coordinator_id
     LEFT JOIN enrollments e ON e.user_id = l.user_id AND e.course_id = l.course_id
     WHERE ${where.join(' AND ')}
     ORDER BY (l.next_follow_up_at IS NULL), l.next_follow_up_at ASC, l.id DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, (page - 1) * limit]
  )
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM leads l WHERE ${where.join(' AND ')}`, values)
  return {
    leads: rows.map((r) => ({
      ...r,
      enrolled: Boolean(r.enrolled),
      ticket_size: r.ticket_size == null ? null : Number(r.ticket_size),
    })),
    counts,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  }
}

/**
 * Leads whose ticket size counts as earned: a confirmed payment on the lead,
 * or the lead reached Course Done. earned_at = whichever came first.
 */
export const TICKET_EARNED_SQL = `
  SELECT l.id, l.owner_id, l.ticket_currency AS currency, l.ticket_size AS amount,
         LEAST(
           COALESCE((SELECT MIN(p.created_at) FROM payments p WHERE p.lead_id = l.id AND p.status = 'success'), '9999-12-31'),
           CASE WHEN l.stage = 'course_done' THEN COALESCE(l.stage_changed_at, l.updated_at, l.created_at) ELSE '9999-12-31' END
         ) AS earned_at,
         EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = l.id AND p.status = 'success') AS paid,
         (l.stage = 'course_done') AS course_done
  FROM leads l
  WHERE l.archived_at IS NULL AND l.ticket_size IS NOT NULL
    AND (l.stage = 'course_done' OR EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = l.id AND p.status = 'success'))`

/** KPI row and today's work (PRD §4.1). Sales/revenue arrive with phase 5. */
export const dashboard = async (actor) => {
  assertCrmUser(actor)
  const scope = scopeFor(actor)
  const { start, end } = todayBounds()
  const [[k]] = await pool.query(
    `SELECT
       SUM(l.stage NOT IN ('not_interested','junk','course_done')) AS open_leads,
       SUM(l.stage = 'new') AS new_leads,
       SUM(l.stage = 'in_conversation') AS in_conversation,
       SUM(l.stage = 'application') AS applications,
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
       SUM(l.exam_status = 'scheduled') AS exams_scheduled,
       SUM(l.exam_status = 'scheduled' AND l.exam_scheduled_at >= UTC_TIMESTAMP()
           AND l.exam_scheduled_at < UTC_TIMESTAMP() + INTERVAL 7 DAY) AS exams_next_7_days,
       SUM(l.exam_status = 'completed') AS exams_completed,
       SUM(l.exam_status = 'completed' AND l.exam_completed_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')) AS exams_completed_this_month,
       SUM(l.exam_result = 'passed') AS exams_passed,
       SUM(l.exam_status = 'completed' AND l.stage <> 'course_done') AS awaiting_course_done
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
     WHERE ${scope.sql} AND l.archived_at IS NULL AND l.exam_status = 'scheduled'
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
      awaiting_course_done: num(ex.awaiting_course_done),
      upcoming: upcomingExams,
    },
    // Open applications by currency (expected value)
    pipeline: isSuper ? tickets.map((t) => ({ currency: t.currency, leads: num(t.leads), amount: Number(t.amount ?? 0) })) : null,
    kpis: {
      open_leads: num(k.open_leads),
      new_leads: num(k.new_leads),
      follow_ups_today: num(f.due_today),
      overdue_follow_ups: num(f.overdue),
      in_conversation: num(k.in_conversation),
      applications: num(k.applications),
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
               AND l.exam_status <> 'completed') AS open_exams
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

/** Anyone with access to the lead: schedule, complete or reset the exam. */
export const updateExam = async (req, id, { status, scheduled_at, completed_at, result, note }) => {
  const actor = req.user
  const lead = await loadVisibleLead(actor, id)
  if (!EXAM_STATUSES.includes(status)) throw fail(400, 'Unknown exam status')
  const next = { status, scheduled_at: null, completed_at: null, result: null, note: note?.trim() || null }
  if (status === 'scheduled') {
    if (!scheduled_at) throw fail(400, 'Choose the exam date')
    next.scheduled_at = toSqlDate(scheduled_at)
  }
  if (status === 'completed') {
    next.scheduled_at = lead.exam_scheduled_at ? toSqlDate(lead.exam_scheduled_at) : null
    next.completed_at = toSqlDate(completed_at || new Date())
    next.result = result ?? null
  }
  await pool.query(
    `UPDATE leads SET exam_status = ?, exam_scheduled_at = ?, exam_completed_at = ?, exam_result = ?, exam_note = ?
     WHERE id = ?`,
    [next.status, next.scheduled_at, next.completed_at, next.result, next.note, lead.id]
  )
  const type = { scheduled: 'exam_scheduled', completed: 'exam_completed', not_scheduled: 'exam_cleared' }[status]
  await addActivity(lead.id, actor.id, type, next.note, {
    ...(next.scheduled_at && { scheduled_at: sqlToIso(next.scheduled_at) }),
    ...(next.completed_at && { completed_at: sqlToIso(next.completed_at) }),
    ...(next.result && { result: next.result }),
  })
  await audit(req, { action: `lead.${type}`, targetType: 'lead', targetId: lead.id, details: { status, result: next.result } })
  if (status === 'completed') {
    const others = [lead.owner_id, lead.exam_coordinator_id].filter((u) => u && u !== actor.id)
    const note = {
      type: 'exam_completed',
      title: `${lead.name} completed the exam${next.result ? ` (${next.result})` : ''}`,
      body: 'You can now mark the course as done',
    }
    if (others.length) await notify(others, { ...note, link: `/consultant/leads?lead=${lead.id}` })
    else if (isCoordinator(actor) && !lead.owner_id) await notify(await managerIds(), { ...note, link: `/admin/leads?lead=${lead.id}` })
  }
  return getLead(actor, lead.id)
}

/** People a lead can be assigned to (Admin create form). */
export const assignableOwners = async (actor) => {
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
