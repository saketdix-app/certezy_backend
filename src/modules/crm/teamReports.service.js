// src/modules/crm/teamReports.service.js
// CRM → Reports: three per-person reports for any period (IST days).
//
//   • Calls       — from the Team app's call log (only calls with a lead's number)
//                   and calls logged by hand: totals, connected, missed, talk time,
//                   calls of 2+ minutes, unique leads, working / idle hours.
//   • Follow-ups  — leads assigned vs. what was done with them: contacted, time to
//                   first contact, follow-ups due / done / missed, activity logged.
//   • Team        — one board for the daily meeting: leads, contacted, calls,
//                   applications, exams, payments, closed, per consultant.
// For people with "CRM reports" access (Admins, and Sub-Admins given it).

import { pool } from '../../config/db.js'
import { can } from '../../utils/access.js'
import { IST } from '../../utils/ist.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const n = (v) => Number(v ?? 0)
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0)
const toSql = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ')
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const IST_OFFSET_MIN = 330

const assertReports = (actor) => {
  if (!can(actor, 'can_view_crm_reports')) throw fail(403, 'Reports are for Admins')
}

/** Today's date in IST, as YYYY-MM-DD. */
export const istToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(now)

/** from / to are IST days (default: today). Returns UTC SQL bounds [start, end). */
export const istRange = ({ from, to } = {}) => {
  const today = istToday()
  const f = DAY_RE.test(String(from ?? '')) ? from : DAY_RE.test(String(to ?? '')) ? to : today
  const t = DAY_RE.test(String(to ?? '')) ? to : f
  const start = new Date(`${f}T00:00:00+05:30`)
  const end = new Date(new Date(`${t}T00:00:00+05:30`).getTime() + 86400e3)
  if (!(start < end)) throw fail(400, 'The start date must be on or before the end date')
  if (end - start > 370 * 86400e3) throw fail(400, 'Choose a period of up to a year')
  return { from: f, to: t, start: toSql(start), end: toSql(end), days: Math.round((end - start) / 86400e3) }
}

const ids = (v) =>
  String(v ?? '')
    .split(',')
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0)

/** Consultants (active, or with work in the period), optionally only the chosen ones. */
const people = async (q, extraIds = []) => {
  const only = ids(q.user_ids)
  const [rows] = await pool.query(
    `SELECT id, name, mobile, role, is_active FROM users
     WHERE deleted_at IS NULL AND (role = 'consultant' ${extraIds.length ? 'OR id IN (?)' : ''})
     ORDER BY is_active DESC, name`,
    extraIds.length ? [extraIds] : []
  )
  return rows
    .filter((u) => (only.length ? only.includes(u.id) : u.is_active || extraIds.includes(u.id)))
    .map((u) => ({ id: u.id, name: u.name, mobile: u.mobile || null, role: u.role, active: Boolean(u.is_active) }))
}

// ─────────────────────────── 1. Calls ───────────────────────────

const DIR = `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.direction')), 'logged')`
const DUR = `COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.duration_sec')) AS UNSIGNED), 0)`
const CONNECTED = `(${DIR} IN ('incoming', 'outgoing') AND ${DUR} > 0)`
export const CALL_TYPES = {
  outgoing: `${DIR} IN ('outgoing', 'unanswered')`,
  incoming: `${DIR} = 'incoming'`,
  missed: `${DIR} IN ('missed', 'rejected')`,
  unanswered: `${DIR} = 'unanswered'`,
  connected: CONNECTED,
  logged: `${DIR} = 'logged'`,
}

export const callReport = async (actor, q = {}) => {
  assertReports(actor)
  const range = istRange(q)
  const where = ["a.type = 'call'", 'a.created_at >= ?', 'a.created_at < ?']
  const values = [range.start, range.end]
  if (Object.hasOwn(CALL_TYPES, q.call_type ?? '')) where.push(CALL_TYPES[q.call_type])
  const minDur = Number(q.min_duration)
  if (minDur > 0) {
    where.push(`${DUR} >= ?`)
    values.push(Math.round(minDur))
  }
  const W = where.join(' AND ')

  const [rows] = await pool.query(
    `SELECT a.actor_id AS id,
            COUNT(*) AS total, SUM(${DUR}) AS duration,
            SUM(${DIR} IN ('outgoing', 'unanswered')) AS outgoing,
            SUM(${DIR} = 'incoming') AS incoming,
            SUM(${DIR} IN ('missed', 'rejected')) AS missed,
            SUM(${DIR} = 'unanswered') AS unanswered,
            SUM(${DIR} = 'logged') AS logged,
            SUM(${CONNECTED}) AS connected,
            SUM(CASE WHEN ${CONNECTED} THEN ${DUR} ELSE 0 END) AS connected_duration,
            SUM(${CONNECTED} AND ${DUR} >= 120) AS long_calls,
            COUNT(DISTINCT a.lead_id) AS unique_leads,
            COUNT(DISTINCT CASE WHEN ${CONNECTED} THEN a.lead_id END) AS unique_connected,
            MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at
     FROM lead_activities a WHERE ${W} AND a.actor_id IS NOT NULL
     GROUP BY a.actor_id`,
    values
  )
  // Working hours: start of the first call to end of the last call, each IST day, added up; idle = working − talk time
  const [days] = await pool.query(
    `SELECT a.actor_id AS id, DATE(a.created_at + INTERVAL ${IST_OFFSET_MIN} MINUTE) AS d,
            TIMESTAMPDIFF(SECOND, MIN(a.created_at), MAX(a.created_at + INTERVAL ${DUR} SECOND)) AS span, SUM(${DUR}) AS talk
     FROM lead_activities a WHERE ${W} AND a.actor_id IS NOT NULL
     GROUP BY a.actor_id, d`,
    values
  )
  const work = {}
  for (const d of days) {
    const w = (work[d.id] ??= { working: 0, talk: 0 })
    w.working += n(d.span)
    w.talk += n(d.talk)
  }
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  const list = await people(q, rows.map((r) => r.id))
  const out = list.map((p) => {
    const r = byId[p.id] ?? {}
    const w = work[p.id] ?? { working: 0, talk: 0 }
    const connected = n(r.connected)
    return {
      ...p,
      total: n(r.total),
      duration: n(r.duration),
      outgoing: n(r.outgoing),
      incoming: n(r.incoming),
      missed: n(r.missed),
      unanswered: n(r.unanswered),
      logged: n(r.logged),
      connected,
      connected_duration: n(r.connected_duration),
      avg_connected: connected ? Math.round(n(r.connected_duration) / connected) : 0,
      long_calls: n(r.long_calls),
      unique_leads: n(r.unique_leads),
      unique_connected: n(r.unique_connected),
      working: w.working,
      idle: Math.max(0, w.working - w.talk),
      first_at: r.first_at ? new Date(r.first_at).toISOString() : null,
      last_at: r.last_at ? new Date(r.last_at).toISOString() : null,
    }
  })
  const sum = (k) => out.reduce((a, r) => a + r[k], 0)
  const totals = Object.fromEntries(
    ['total', 'duration', 'outgoing', 'incoming', 'missed', 'unanswered', 'logged', 'connected', 'connected_duration', 'long_calls', 'unique_leads', 'unique_connected', 'working', 'idle'].map((k) => [k, sum(k)])
  )
  totals.avg_connected = totals.connected ? Math.round(totals.connected_duration / totals.connected) : 0
  return { period: { from: range.from, to: range.to, timezone: IST }, rows: out, totals }
}

// ───────────────────── 2. Assigned leads vs follow-up ─────────────────────

const TALK_TYPES = "('call', 'message', 'email', 'whatsapp', 'whatsapp_api', 'follow_up_done')"

export const followUpReport = async (actor, q = {}) => {
  assertReports(actor)
  const range = istRange(q)
  const { start, end } = range
  // Leads assigned to each person in the period, and what happened to them
  const [assigned] = await pool.query(
    `SELECT l.owner_id AS id, COUNT(*) AS assigned,
            SUM(EXISTS (SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id AND a.type IN ${TALK_TYPES}
                         AND a.created_at >= COALESCE(l.assigned_at, l.created_at))) AS contacted,
            SUM(EXISTS (SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id AND a.type = 'call'
                         AND JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.direction')) IN ('incoming', 'outgoing')
                         AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.duration_sec')) AS UNSIGNED) > 0
                         AND a.created_at >= COALESCE(l.assigned_at, l.created_at))) AS connected,
            SUM(l.stage = 'backlog' OR l.stage = 'new') AS not_started,
            SUM(l.owner_seen_at IS NULL OR l.owner_seen_at < l.assigned_at) AS not_opened,
            SUM(EXISTS (SELECT 1 FROM lead_follow_ups f WHERE f.lead_id = l.id AND f.status = 'pending')) AS with_follow_up,
            AVG(CASE WHEN l.first_contact_at IS NOT NULL AND l.first_contact_at >= COALESCE(l.assigned_at, l.created_at)
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(l.assigned_at, l.created_at), l.first_contact_at) END) AS first_contact_min
     FROM leads l
     WHERE l.owner_id IS NOT NULL AND l.archived_at IS NULL
       AND COALESCE(l.assigned_at, l.created_at) >= ? AND COALESCE(l.assigned_at, l.created_at) < ?
     GROUP BY l.owner_id`,
    [start, end]
  )
  // Follow-ups due in the period
  const [fu] = await pool.query(
    `SELECT f.owner_id AS id, COUNT(*) AS due,
            SUM(f.status = 'done') AS done,
            SUM(f.status = 'done' AND f.completed_at <= f.due_at + INTERVAL 1 HOUR) AS on_time,
            SUM(f.status = 'missed' OR (f.status = 'pending' AND f.due_at < UTC_TIMESTAMP())) AS missed,
            SUM(f.status = 'pending' AND f.due_at >= UTC_TIMESTAMP()) AS upcoming,
            SUM(f.status = 'cancelled') AS cancelled
     FROM lead_follow_ups f WHERE f.owner_id IS NOT NULL AND f.due_at >= ? AND f.due_at < ?
     GROUP BY f.owner_id`,
    [start, end]
  )
  // Work logged on leads in the period (by the person who did it)
  const [acts] = await pool.query(
    `SELECT a.actor_id AS id,
            SUM(a.type = 'call') AS calls, SUM(a.type IN ('whatsapp', 'whatsapp_api')) AS whatsapp,
            SUM(a.type = 'email') AS emails, SUM(a.type IN ('note', 'message')) AS notes,
            COUNT(DISTINCT CASE WHEN a.type IN ${TALK_TYPES} THEN a.lead_id END) AS leads_worked
     FROM lead_activities a WHERE a.actor_id IS NOT NULL AND a.created_at >= ? AND a.created_at < ?
     GROUP BY a.actor_id`,
    [start, end]
  )
  // Right now: open leads nobody has talked to for 7+ days, and overdue follow-ups
  const [now] = await pool.query(
    `SELECT l.owner_id AS id,
            SUM(l.stage NOT IN ('not_interested', 'junk', 'course_done') AND NOT EXISTS (
                SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id AND a.type IN ${TALK_TYPES}
                  AND a.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY)) AS quiet_7d,
            SUM(l.next_follow_up_at < UTC_TIMESTAMP() AND l.stage NOT IN ('not_interested', 'junk', 'course_done')) AS overdue_now,
            SUM(l.stage NOT IN ('not_interested', 'junk', 'course_done')) AS open_now
     FROM leads l WHERE l.owner_id IS NOT NULL AND l.archived_at IS NULL
     GROUP BY l.owner_id`
  )
  const by = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]))
  const A = by(assigned)
  const F = by(fu)
  const X = by(acts)
  const N = by(now)
  const list = await people(q, [...assigned, ...fu].map((r) => r.id))
  const rows = list.map((p) => {
    const a = A[p.id] ?? {}
    const f = F[p.id] ?? {}
    const x = X[p.id] ?? {}
    const w = N[p.id] ?? {}
    return {
      ...p,
      assigned: n(a.assigned),
      contacted: n(a.contacted),
      contacted_pct: pct(n(a.contacted), n(a.assigned)),
      connected: n(a.connected),
      not_contacted: n(a.assigned) - n(a.contacted),
      not_opened: n(a.not_opened),
      with_follow_up: n(a.with_follow_up),
      first_contact_min: a.first_contact_min == null ? null : Math.round(n(a.first_contact_min)),
      fu_due: n(f.due),
      fu_done: n(f.done),
      fu_on_time: n(f.on_time),
      fu_missed: n(f.missed),
      fu_upcoming: n(f.upcoming),
      fu_cancelled: n(f.cancelled),
      fu_done_pct: pct(n(f.done), n(f.due) - n(f.upcoming) - n(f.cancelled)),
      calls: n(x.calls),
      whatsapp: n(x.whatsapp),
      emails: n(x.emails),
      notes: n(x.notes),
      leads_worked: n(x.leads_worked),
      open_now: n(w.open_now),
      quiet_7d: n(w.quiet_7d),
      overdue_now: n(w.overdue_now),
    }
  })
  const keys = ['assigned', 'contacted', 'connected', 'not_contacted', 'not_opened', 'with_follow_up', 'fu_due', 'fu_done', 'fu_on_time', 'fu_missed', 'fu_upcoming', 'calls', 'whatsapp', 'emails', 'notes', 'leads_worked', 'open_now', 'quiet_7d', 'overdue_now']
  const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)]))
  totals.contacted_pct = pct(totals.contacted, totals.assigned)
  const cancelled = rows.reduce((s, r) => s + r.fu_cancelled, 0)
  totals.fu_done_pct = pct(totals.fu_done, totals.fu_due - totals.fu_upcoming - cancelled)
  return { period: { from: range.from, to: range.to, timezone: IST }, rows, totals }
}

// ─────────────────────────── 3. Team board ───────────────────────────

export const teamBoard = async (actor, q = {}) => {
  assertReports(actor)
  const range = istRange(q)
  const { start, end } = range
  const fromDay = range.from
  const toDay = range.to
  const [leadRows] = await pool.query(
    `SELECT l.owner_id AS id,
            SUM(COALESCE(l.assigned_at, l.created_at) >= ? AND COALESCE(l.assigned_at, l.created_at) < ?) AS leads,
            SUM(l.first_contact_at >= ? AND l.first_contact_at < ?) AS first_contacts,
            SUM(l.application_submitted = 1 AND l.application_submitted_at >= ? AND l.application_submitted_at <= ?) AS applications,
            SUM(l.exam_status IN ('scheduled', 'rescheduled') AND l.exam_scheduled_at >= ? AND l.exam_scheduled_at < ?) AS exams_scheduled,
            SUM(l.exam_done = 1 AND l.exam_completed_at >= ? AND l.exam_completed_at < ?) AS exams_done,
            SUM(l.exam_result = 'passed' AND l.exam_completed_at >= ? AND l.exam_completed_at < ?) AS exams_passed,
            SUM(l.payment_status = 'done' AND l.payment_done_at >= ? AND l.payment_done_at < ?) AS payments,
            SUM(l.stage IN ('not_interested', 'junk') AND l.stage_changed_at >= ? AND l.stage_changed_at < ?) AS closed_lost,
            SUM(l.stage NOT IN ('not_interested', 'junk', 'course_done')) AS open_now
     FROM leads l WHERE l.owner_id IS NOT NULL AND l.archived_at IS NULL
     GROUP BY l.owner_id`,
    [start, end, start, end, fromDay, toDay, start, end, start, end, start, end, start, end, start, end]
  )
  const [callRows] = await pool.query(
    `SELECT a.actor_id AS id, COUNT(*) AS calls, SUM(${CONNECTED}) AS connected,
            SUM(CASE WHEN ${CONNECTED} THEN ${DUR} ELSE 0 END) AS talk,
            SUM(${CONNECTED} AND ${DUR} >= 120) AS long_calls
     FROM lead_activities a WHERE a.type = 'call' AND a.actor_id IS NOT NULL AND a.created_at >= ? AND a.created_at < ?
     GROUP BY a.actor_id`,
    [start, end]
  )
  const [fuRows] = await pool.query(
    `SELECT f.owner_id AS id, SUM(f.status = 'done') AS done,
            SUM(f.status = 'missed' OR (f.status = 'pending' AND f.due_at < UTC_TIMESTAMP())) AS missed
     FROM lead_follow_ups f WHERE f.owner_id IS NOT NULL AND f.due_at >= ? AND f.due_at < ?
     GROUP BY f.owner_id`,
    [start, end]
  )
  // Leads per IST day (for the trend line)
  const [daily] = await pool.query(
    `SELECT DATE_FORMAT(COALESCE(l.assigned_at, l.created_at) + INTERVAL ${IST_OFFSET_MIN} MINUTE, '%Y-%m-%d') AS d, COUNT(*) AS leads
     FROM leads l WHERE l.archived_at IS NULL AND l.owner_id IS NOT NULL
       AND COALESCE(l.assigned_at, l.created_at) >= ? AND COALESCE(l.assigned_at, l.created_at) < ?
     GROUP BY d ORDER BY d`,
    [start, end]
  )
  const [dailyCalls] = await pool.query(
    `SELECT DATE_FORMAT(a.created_at + INTERVAL ${IST_OFFSET_MIN} MINUTE, '%Y-%m-%d') AS d,
            COUNT(*) AS calls, SUM(${CONNECTED}) AS connected
     FROM lead_activities a WHERE a.type = 'call' AND a.actor_id IS NOT NULL AND a.created_at >= ? AND a.created_at < ?
     GROUP BY d ORDER BY d`,
    [start, end]
  )
  const by = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]))
  const L = by(leadRows)
  const C = by(callRows)
  const F = by(fuRows)
  const list = await people(q, callRows.map((r) => r.id))
  const rows = list.map((p) => {
    const l = L[p.id] ?? {}
    const c = C[p.id] ?? {}
    const f = F[p.id] ?? {}
    return {
      ...p,
      leads: n(l.leads),
      first_contacts: n(l.first_contacts),
      calls: n(c.calls),
      connected: n(c.connected),
      talk: n(c.talk),
      long_calls: n(c.long_calls),
      fu_done: n(f.done),
      fu_missed: n(f.missed),
      applications: n(l.applications),
      exams_scheduled: n(l.exams_scheduled),
      exams_done: n(l.exams_done),
      exams_passed: n(l.exams_passed),
      payments: n(l.payments),
      closed_lost: n(l.closed_lost),
      open_now: n(l.open_now),
    }
  })
  const keys = ['leads', 'first_contacts', 'calls', 'connected', 'talk', 'long_calls', 'fu_done', 'fu_missed', 'applications', 'exams_scheduled', 'exams_done', 'exams_passed', 'payments', 'closed_lost', 'open_now']
  const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)]))
  // Every day of the period, zeros included (up to 62 days)
  const series = []
  const L2 = Object.fromEntries(daily.map((r) => [r.d, n(r.leads)]))
  const C2 = Object.fromEntries(dailyCalls.map((r) => [r.d, r]))
  if (range.days <= 62) {
    for (let i = 0; i < range.days; i++) {
      const d = new Date(new Date(`${fromDay}T00:00:00Z`).getTime() + i * 86400e3).toISOString().slice(0, 10)
      series.push({ day: d, leads: L2[d] ?? 0, calls: n(C2[d]?.calls), connected: n(C2[d]?.connected) })
    }
  }
  return { period: { from: range.from, to: range.to, timezone: IST }, rows, totals, series }
}
