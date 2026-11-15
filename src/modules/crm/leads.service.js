// src/modules/crm/leads.service.js
// 2.0 Phase 3 — lead records, pipeline, activity timeline and follow-ups
// (PRD §4–§5). Access is enforced here, not in the UI:
//   • Consultants see and work only leads they own.
//   • Admins and Super Admins see all leads.
//   • Closed leads (Not Interested / Junk) reopen only with a reason, by an Admin.
//   • "Course Done" = the linked student has completed the course (all lessons
//     and every exam). Enrollment is tracked separately.

import { pool } from '../../config/db.js'
import env from '../../config/env.js'
import { audit } from '../../utils/audit.js'
import { getCompletionStatus } from '../certificates/certificates.service.js'
import { autoAssign } from './distribution.service.js'
import {
  CLOSED_STAGES,
  REASON_REQUIRED,
  STAGE_LABELS,
  STAGES,
  TRANSITIONS,
} from './crm.constants.js'

const fail = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra)
const MANAGERS = ['super_admin', 'admin']
const isManager = (actor) => MANAGERS.includes(actor?.role)

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
  if (!isManager(actor) && actor?.role !== 'consultant') throw fail(403, 'The CRM is for consultants and admins')
}

/** WHERE fragment limiting leads to what the actor may see. */
const scopeFor = (actor, alias = 'l') =>
  isManager(actor) ? { sql: '1 = 1', values: [] } : { sql: `${alias}.owner_id = ?`, values: [actor.id] }

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
  if (!lead || (!isManager(actor) && lead.owner_id !== actor.id)) throw fail(404, 'Lead not found')
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
const findStudentId = async (email) => {
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
  assertCrmUser(actor)
  if (!body.phone && !body.email) throw fail(400, 'Add a phone number or an email')

  const duplicates = await findDuplicates(body)
  if (duplicates.length) {
    // Never silently create a second record for the same person (PRD §5)
    throw fail(409, 'This person may already be a lead', {
      details: {
        duplicates: duplicates.map((d) =>
          isManager(actor) || d.owner_id === actor.id
            ? d
            : { id: null, name: d.name, stage: d.stage, owner_name: d.owner_name } // other consultant's lead: no access
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

export const updateLead = async (req, id, body) => {
  const actor = req.user
  const lead = await loadVisibleLead(actor, id)
  const next = {
    name: body.name ?? lead.name,
    phone: body.phone !== undefined ? body.phone || null : lead.phone,
    email: body.email !== undefined ? body.email || null : lead.email,
    course_id: body.course_id !== undefined ? body.course_id || null : lead.course_id,
    preferred_schedule: body.preferred_schedule !== undefined ? body.preferred_schedule || null : lead.preferred_schedule,
  }
  if (!next.phone && !next.email) throw fail(400, 'Keep a phone number or an email')
  const dup = await findDuplicates({ phone: next.phone, email: next.email }, lead.id)
  if (dup.length) throw fail(409, 'Another lead already has this phone or email', { details: { duplicates: dup.map((d) => ({ name: d.name, stage: d.stage })) } })

  const changed = Object.keys(next).filter((k) => String(next[k] ?? '') !== String(lead[k] ?? ''))
  if (!changed.length) return getLead(actor, lead.id)
  await pool.query(
    `UPDATE leads SET name = ?, phone = ?, phone_norm = ?, email = ?, email_norm = ?, course_id = ?,
       preferred_schedule = ?, user_id = COALESCE(user_id, ?) WHERE id = ?`,
    [
      next.name,
      next.phone,
      normalizePhone(next.phone),
      next.email,
      normalizeEmail(next.email),
      next.course_id,
      next.preferred_schedule,
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

/** Stages this actor may move the lead to now. */
const allowedNextStages = (actor, lead) =>
  (TRANSITIONS[lead.stage] ?? []).filter((s) => !CLOSED_STAGES.includes(lead.stage) || isManager(actor))

export const changeStage = async (req, id, { stage, reason }) => {
  const actor = req.user
  const lead = await loadVisibleLead(actor, id)
  if (!STAGES.includes(stage)) throw fail(400, 'Unknown stage')
  if (stage === lead.stage) throw fail(409, `This lead is already in ${STAGE_LABELS[stage]}`)

  const reopening = CLOSED_STAGES.includes(lead.stage)
  if (reopening && !isManager(actor)) {
    await audit(req, { action: 'lead.reopen', targetType: 'lead', targetId: lead.id, result: 'denied', details: { from: lead.stage, to: stage } })
    throw fail(403, 'Only an Admin can reopen a closed lead')
  }
  if (!(TRANSITIONS[lead.stage] ?? []).includes(stage)) {
    throw fail(400, `A lead in ${STAGE_LABELS[lead.stage]} can't move to ${STAGE_LABELS[stage]}`)
  }
  const why = String(reason ?? '').trim()
  if ((REASON_REQUIRED.includes(stage) || reopening) && !why) {
    throw fail(400, reopening ? 'Give a reason for reopening this lead' : `Give a reason for ${STAGE_LABELS[stage]}`)
  }
  if (stage === 'course_done') {
    const progress = await studentProgress(lead)
    if (!lead.user_id || !lead.course_id) {
      throw fail(400, 'Link this lead to a student account and course first (same email as their account)')
    }
    if (!progress.course_completed) {
      throw fail(400, `The student hasn't completed the course yet${progress.completion_note ? ` — ${progress.completion_note}` : ''}`)
    }
  }

  await pool.query(
    `UPDATE leads SET stage = ?, prior_stage = ?, stage_reason = ?, stage_changed_at = UTC_TIMESTAMP(),
       disposition_reason = ?, first_contact_at = COALESCE(first_contact_at, ?)
     WHERE id = ?`,
    [
      stage,
      lead.stage,
      why || null,
      CLOSED_STAGES.includes(stage) ? why : null,
      lead.stage === 'new' && !CLOSED_STAGES.includes(stage) ? toSqlDate(new Date()) : null,
      lead.id,
    ]
  )
  await addActivity(lead.id, actor.id, 'status_change', why || null, { from: lead.stage, to: stage })
  await audit(req, {
    action: reopening ? 'lead.reopen' : 'lead.stage_change',
    targetType: 'lead',
    targetId: lead.id,
    details: { from: lead.stage, to: stage, reason: why || undefined },
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
  assertCrmUser(actor)
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
            ab.name AS assigned_by_name, s.name AS student_name, s.email AS student_email
     FROM leads l
     LEFT JOIN courses c ON c.id = l.course_id
     LEFT JOIN users o ON o.id = l.owner_id
     LEFT JOIN users ab ON ab.id = l.assigned_by
     LEFT JOIN users s ON s.id = l.user_id
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
            (e.id IS NOT NULL) AS enrolled
     FROM leads l
     LEFT JOIN courses c ON c.id = l.course_id
     LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN enrollments e ON e.user_id = l.user_id AND e.course_id = l.course_id
     WHERE ${where.join(' AND ')}
     ORDER BY (l.next_follow_up_at IS NULL), l.next_follow_up_at ASC, l.id DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, (page - 1) * limit]
  )
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM leads l WHERE ${where.join(' AND ')}`, values)
  return {
    leads: rows.map((r) => ({ ...r, enrolled: Boolean(r.enrolled) })),
    counts,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  }
}

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
  const num = (v) => Number(v ?? 0)
  return {
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

/** People a lead can be assigned to (Admin create form). */
export const assignableOwners = async (actor) => {
  if (!isManager(actor)) throw fail(403, 'Only Admins assign leads')
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.role, cs.accepting_leads
     FROM users u LEFT JOIN consultant_settings cs ON cs.user_id = u.id
     WHERE u.is_active = 1 AND u.deleted_at IS NULL AND u.role IN ('consultant', 'admin', 'super_admin')
     ORDER BY FIELD(u.role, 'consultant', 'admin', 'super_admin'), u.name`
  )
  return rows
}
