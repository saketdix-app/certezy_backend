// src/modules/crm/reports.service.js
// 2.0 Phase 6 — management reports (PRD §9.1). Admins and Super Admins only.
//
//   • Lead volume by day / week / month, and by source, campaign, course, status
//   • Conversion rate by source, campaign, course and consultant
//     (converted = the lead has a confirmed, attributed sale)
//   • Consultants: leads, contact attempts, follow-ups, applications,
//     conversions, revenue, time to first contact
//   • Lead ageing (open leads by age) and time to first contact
//   • LMS: course assignments, enrollments, certificates issued
//   • Operations: unassigned, transfers, overdue follow-ups, distribution balance
//   • Exams: scheduled / completed / passed in the period, per Exam Coordinator
//   • Ticket size (INR / USD) of applications, overall and per consultant
// Days are counted in the business timezone (APP_TIMEZONE).

import { pool } from '../../config/db.js'
import env from '../../config/env.js'
import { audit } from '../../utils/audit.js'
import { STAGES } from './crm.constants.js'
import { PAYMENT_ALERT_SQL, TICKET_EARNED_SQL } from './leads.service.js'
import { can } from '../../utils/access.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const assertManager = (actor) => {
  if (!can(actor, 'can_view_crm_reports')) throw fail(403, 'Reports are for Admins')
}
const toSql = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ')
const n = (v) => Number(v ?? 0)
const round1 = (v) => Math.round(v * 10) / 10
const rate = (part, whole) => (whole ? round1((part / whole) * 100) : 0)
const OPEN = `l.stage NOT IN ('not_interested', 'junk', 'course_done')`
const CONVERTED = `EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = l.id AND p.status = 'success')`

/** Minutes the business timezone is ahead of UTC right now (India: 330). */
export const tzOffsetMinutes = (tz = env.timezone, at = new Date()) => {
  const local = new Date(at.toLocaleString('en-US', { timeZone: tz }))
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }))
  return Math.round((local - utc) / 60000)
}

/** SQL expression bucketing a UTC datetime column into local day / ISO week / month. */
export const periodExpr = (column, group, offset) => {
  const local = `(${column} + INTERVAL ${Number(offset)} MINUTE)`
  if (group === 'month') return `DATE_FORMAT(${local}, '%Y-%m')`
  if (group === 'week') return `DATE_FORMAT(${local} - INTERVAL WEEKDAY(${local}) DAY, '%Y-%m-%d')` // Monday
  return `DATE_FORMAT(${local}, '%Y-%m-%d')`
}

/** Normalise the period: default last 30 days; returns UTC SQL bounds. */
export const rangeOf = ({ from, to } = {}) => {
  const end = to ? new Date(new Date(to).getTime() + 86400e3) : new Date(Date.now() + 60e3)
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400e3)
  if (!(start < end)) throw fail(400, 'The start date must be before the end date')
  if (end - start > 400 * 86400e3) throw fail(400, 'Choose a period of up to about a year')
  return { start: toSql(start), end: toSql(end) }
}

const breakdown = async (keyExpr, start, end) => {
  const [rows] = await pool.query(
    `SELECT ${keyExpr} AS k, COUNT(*) AS leads, SUM(${CONVERTED}) AS converted
     FROM leads l WHERE l.created_at >= ? AND l.created_at < ? AND l.archived_at IS NULL
     GROUP BY k ORDER BY leads DESC LIMIT 50`,
    [start, end]
  )
  return rows.map((r) => ({ key: r.k ?? null, leads: n(r.leads), converted: n(r.converted), rate: rate(n(r.converted), n(r.leads)) }))
}

/** Revenue figures are for Super Admins only; Admins get the same report without amounts. */
const withoutMoney = (r) => ({
  ...r,
  money_visible: false,
  consultants: r.consultants.map((c) => ({ ...c, revenue: null, ticket_size: null, ticket_revenue: null })),
  discount_links: { ...r.discount_links, revenue: null },
  pipeline: null,
  ticket_revenue: null,
})

export const overview = async (actor, q = {}) => {
  const report = await buildOverview(actor, q)
  return actor.role === 'super_admin' ? { ...report, money_visible: true } : withoutMoney(report)
}

const buildOverview = async (actor, q = {}) => {
  assertManager(actor)
  const { start, end } = rangeOf(q)
  const group = ['day', 'week', 'month'].includes(q.group) ? q.group : 'day'
  const offset = tzOffsetMinutes()

  // ── Volume ──
  const [series] = await pool.query(
    `SELECT ${periodExpr('l.created_at', group, offset)} AS period, COUNT(*) AS leads, SUM(${CONVERTED}) AS converted
     FROM leads l WHERE l.created_at >= ? AND l.created_at < ? AND l.archived_at IS NULL
     GROUP BY period ORDER BY period`,
    [start, end]
  )
  const [[totals]] = await pool.query(
    `SELECT COUNT(*) AS leads, SUM(${CONVERTED}) AS converted, SUM(l.first_contact_at IS NOT NULL) AS contacted
     FROM leads l WHERE l.created_at >= ? AND l.created_at < ? AND l.archived_at IS NULL`,
    [start, end]
  )

  // ── Breakdowns with conversion ──
  const [bySource, byCampaign, byCourse, byStatus] = await Promise.all([
    breakdown('l.source', start, end),
    breakdown(`NULLIF(JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.campaign')), '')`, start, end),
    breakdown(`(SELECT c.title FROM courses c WHERE c.id = l.course_id)`, start, end),
    breakdown('l.stage', start, end),
  ])

  // ── Consultants ──
  const [people] = await pool.query(
    `SELECT id, name, is_active FROM users WHERE role = 'consultant' AND deleted_at IS NULL ORDER BY name`
  )
  const [owned] = await pool.query(
    `SELECT l.owner_id AS id, COUNT(*) AS leads, SUM(${CONVERTED}) AS converted,
            SUM(l.stage = 'application') AS applications,
            AVG(CASE WHEN l.first_contact_at IS NOT NULL
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(l.assigned_at, l.created_at), l.first_contact_at) END) AS avg_first_contact_min
     FROM leads l WHERE l.owner_id IS NOT NULL AND l.created_at >= ? AND l.created_at < ? AND l.archived_at IS NULL
     GROUP BY l.owner_id`,
    [start, end]
  )
  const [attempts] = await pool.query(
    `SELECT a.actor_id AS id, COUNT(*) AS n FROM lead_activities a
     WHERE a.type IN ('call', 'message', 'whatsapp', 'email') AND a.created_at >= ? AND a.created_at < ?
     GROUP BY a.actor_id`,
    [start, end]
  )
  const [followUps] = await pool.query(
    `SELECT f.owner_id AS id,
            SUM(f.status = 'done' AND f.completed_at >= ? AND f.completed_at < ?) AS done,
            SUM(f.status = 'missed' AND f.completed_at >= ? AND f.completed_at < ?) AS missed,
            SUM(f.status = 'pending' AND f.due_at < UTC_TIMESTAMP()) AS overdue
     FROM lead_follow_ups f GROUP BY f.owner_id`,
    [start, end, start, end]
  )
  const [revenue] = await pool.query(
    `SELECT p.attributed_to AS id, p.currency, COUNT(*) AS sales, SUM(p.amount) AS amount
     FROM payments p WHERE p.status = 'success' AND p.lead_id IS NOT NULL AND p.created_at >= ? AND p.created_at < ?
     GROUP BY p.attributed_to, p.currency`,
    [start, end]
  )
  const [ticketRows] = await pool.query(
    `SELECT l.owner_id AS id, l.ticket_currency AS currency, COUNT(*) AS leads, SUM(l.ticket_size) AS amount
     FROM leads l WHERE l.ticket_size IS NOT NULL AND l.owner_id IS NOT NULL AND l.archived_at IS NULL
       AND l.created_at >= ? AND l.created_at < ?
     GROUP BY l.owner_id, l.ticket_currency`,
    [start, end]
  )
  // Ticket size earned in the period (paid or Course Done), by consultant and currency
  const [earnedRows] = await pool.query(
    `SELECT t.owner_id AS id, t.currency, COUNT(*) AS leads, SUM(t.amount) AS amount,
            SUM(t.paid) AS paid_leads, SUM(t.course_done) AS course_done_leads
     FROM (${TICKET_EARNED_SQL}) t WHERE t.earned_at >= ? AND t.earned_at < ?
     GROUP BY t.owner_id, t.currency`,
    [start, end]
  )
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]))
  const ownedOf = byId(owned)
  const attemptsOf = byId(attempts)
  const fuOf = byId(followUps)
  const consultants = people.map((p) => {
    const o = ownedOf[p.id] ?? {}
    const money = revenue.filter((r) => r.id === p.id)
    return {
      id: p.id,
      name: p.name,
      active: Boolean(p.is_active),
      leads: n(o.leads),
      contact_attempts: n(attemptsOf[p.id]?.n),
      follow_ups_done: n(fuOf[p.id]?.done),
      follow_ups_missed: n(fuOf[p.id]?.missed),
      follow_ups_overdue: n(fuOf[p.id]?.overdue),
      applications: n(o.applications),
      conversions: n(o.converted),
      conversion_rate: rate(n(o.converted), n(o.leads)),
      sales: money.reduce((s, r) => s + n(r.sales), 0),
      revenue: Object.fromEntries(money.map((r) => [r.currency, round1(n(r.amount))])),
      ticket_size: Object.fromEntries(
        ticketRows.filter((r) => r.id === p.id).map((r) => [r.currency, round1(n(r.amount))])
      ),
      ticket_revenue: Object.fromEntries(
        earnedRows.filter((r) => r.id === p.id).map((r) => [r.currency, round1(n(r.amount))])
      ),
      avg_first_contact_hours: o.avg_first_contact_min == null ? null : round1(n(o.avg_first_contact_min) / 60),
    }
  })

  // ── Ageing & speed ──
  const [[ageing]] = await pool.query(
    `SELECT SUM(TIMESTAMPDIFF(HOUR, l.created_at, UTC_TIMESTAMP()) < 24) AS d0,
            SUM(TIMESTAMPDIFF(HOUR, l.created_at, UTC_TIMESTAMP()) BETWEEN 24 AND 71) AS d1_3,
            SUM(TIMESTAMPDIFF(HOUR, l.created_at, UTC_TIMESTAMP()) BETWEEN 72 AND 167) AS d3_7,
            SUM(TIMESTAMPDIFF(HOUR, l.created_at, UTC_TIMESTAMP()) BETWEEN 168 AND 335) AS d7_14,
            SUM(TIMESTAMPDIFF(HOUR, l.created_at, UTC_TIMESTAMP()) BETWEEN 336 AND 719) AS d14_30,
            SUM(TIMESTAMPDIFF(HOUR, l.created_at, UTC_TIMESTAMP()) >= 720) AS d30,
            SUM(l.stage = 'new' AND l.first_contact_at IS NULL) AS untouched
     FROM leads l WHERE ${OPEN} AND l.archived_at IS NULL`
  )
  const [[speed]] = await pool.query(
    `SELECT COUNT(*) AS contacted,
            AVG(TIMESTAMPDIFF(MINUTE, l.created_at, l.first_contact_at)) AS avg_min,
            SUM(TIMESTAMPDIFF(MINUTE, l.created_at, l.first_contact_at) <= 60) AS within_1h,
            SUM(TIMESTAMPDIFF(MINUTE, l.created_at, l.first_contact_at) <= 1440) AS within_24h
     FROM leads l WHERE l.first_contact_at IS NOT NULL AND l.created_at >= ? AND l.created_at < ? AND l.archived_at IS NULL`,
    [start, end]
  )

  // ── LMS ──
  const [[lms]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM enrollments e WHERE e.enrolled_at >= ? AND e.enrolled_at < ?) AS enrollments,
       (SELECT COUNT(*) FROM enrollments e WHERE e.assigned_by IS NOT NULL AND e.enrolled_at >= ? AND e.enrolled_at < ?) AS assignments,
       (SELECT COUNT(*) FROM enrollments e WHERE e.lead_id IS NOT NULL AND e.enrolled_at >= ? AND e.enrolled_at < ?) AS assignments_from_leads,
       (SELECT COUNT(*) FROM certificates ct WHERE ct.issued_at >= ? AND ct.issued_at < ?) AS certificates,
       (SELECT COUNT(*) FROM certificates ct WHERE ct.override_reason IS NOT NULL AND ct.issued_at >= ? AND ct.issued_at < ?) AS certificate_overrides,
       (SELECT COUNT(*) FROM leads l WHERE l.stage = 'course_done' AND l.stage_changed_at >= ? AND l.stage_changed_at < ?) AS course_done`,
    [start, end, start, end, start, end, start, end, start, end, start, end]
  )
  const [[links]] = await pool.query(
    `SELECT COUNT(*) AS links_sent, SUM(d.is_used = 1) AS redeemed,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN discount_links d2 ON d2.id = p.discount_link_id
             WHERE p.status = 'success' AND d2.created_at >= ? AND d2.created_at < ? AND p.currency = 'USD') AS revenue_usd,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN discount_links d2 ON d2.id = p.discount_link_id
             WHERE p.status = 'success' AND d2.created_at >= ? AND d2.created_at < ? AND p.currency = 'INR') AS revenue_inr
     FROM discount_links d WHERE d.created_at >= ? AND d.created_at < ?`,
    [start, end, start, end, start, end]
  )

  // ── Exams (by date the exam was scheduled for / completed) ──
  const [[examTotals]] = await pool.query(
    `SELECT
       SUM(l.exam_status IN ('scheduled', 'rescheduled') AND l.exam_done = 0 AND l.stage = 'exam_scheduled') AS scheduled_now,
       SUM(l.exam_status IN ('scheduled', 'rescheduled') AND l.exam_done = 0 AND l.exam_scheduled_at < UTC_TIMESTAMP()
           AND l.stage = 'exam_scheduled') AS scheduled_overdue,
       SUM(l.exam_status = 'cancelled' AND l.stage = 'exam_scheduled') AS cancelled_now,
       SUM(l.exam_done = 1 AND l.exam_completed_at >= ? AND l.exam_completed_at < ?) AS completed,
       SUM(l.exam_result = 'passed' AND l.exam_completed_at >= ? AND l.exam_completed_at < ?) AS passed,
       SUM(l.exam_result = 'failed' AND l.exam_completed_at >= ? AND l.exam_completed_at < ?) AS failed,
       SUM(${PAYMENT_ALERT_SQL}) AS payment_alerts,
       SUM(l.payment_status = 'done' AND l.payment_done_at >= ? AND l.payment_done_at < ?) AS payments_done,
       SUM(l.stage = 'application' AND l.application_submitted = 1) AS applications_submitted,
       SUM(l.stage = 'application' AND l.application_submitted = 0) AS applications_not_submitted,
       SUM(l.exam_coordinator_id IS NULL AND l.stage IN ('application', 'exam_scheduled')) AS applications_without_coordinator
     FROM leads l WHERE l.archived_at IS NULL`,
    [start, end, start, end, start, end, start, end]
  )
  const [examSeries] = await pool.query(
    `SELECT ${periodExpr('l.exam_completed_at', group, offset)} AS period, COUNT(*) AS completed
     FROM leads l WHERE l.exam_done = 1 AND l.exam_completed_at >= ? AND l.exam_completed_at < ? AND l.archived_at IS NULL
     GROUP BY period ORDER BY period`,
    [start, end]
  )
  const [coordinatorRows] = await pool.query(
    `SELECT u.id, u.name, u.is_active,
            SUM(l.id IS NOT NULL) AS assigned,
            SUM(l.stage = 'application') AS applications,
            SUM(l.exam_status IN ('scheduled', 'rescheduled') AND l.exam_done = 0 AND l.stage = 'exam_scheduled') AS scheduled,
            SUM(l.exam_done = 1 AND l.exam_completed_at >= ? AND l.exam_completed_at < ?) AS completed,
            SUM(${PAYMENT_ALERT_SQL}) AS payment_alerts,
            SUM(l.exam_result = 'passed' AND l.exam_completed_at >= ? AND l.exam_completed_at < ?) AS passed,
            SUM(l.stage = 'course_done') AS course_done
     FROM users u
     LEFT JOIN leads l ON l.exam_coordinator_id = u.id AND l.archived_at IS NULL
     WHERE u.role = 'exam_coordinator' AND u.deleted_at IS NULL
     GROUP BY u.id, u.name, u.is_active ORDER BY u.name`,
    [start, end, start, end]
  )
  const [pipelineRows] = await pool.query(
    `SELECT l.ticket_currency AS currency, COUNT(*) AS leads, SUM(l.ticket_size) AS amount
     FROM leads l WHERE l.stage = 'application' AND l.ticket_size IS NOT NULL AND l.archived_at IS NULL
     GROUP BY l.ticket_currency`
  )

  // ── Operations ──
  const [[ops]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM leads l WHERE l.owner_id IS NULL AND ${OPEN} AND l.archived_at IS NULL) AS unassigned,
       (SELECT COUNT(*) FROM lead_follow_ups f JOIN leads l ON l.id = f.lead_id
        WHERE f.status = 'pending' AND f.due_at < UTC_TIMESTAMP() AND l.archived_at IS NULL) AS overdue_follow_ups,
       (SELECT COUNT(*) FROM lead_activities a WHERE a.type = 'assignment'
        AND JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.how')) IN ('transfer', 'rebalance') AND a.created_at >= ? AND a.created_at < ?) AS transfers`,
    [start, end]
  )
  const [rr] = await pool.query(
    `SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.to')) AS UNSIGNED) AS id, COUNT(*) AS n
     FROM lead_activities a WHERE a.type = 'assignment' AND JSON_UNQUOTE(JSON_EXTRACT(a.meta, '$.how')) = 'round_robin'
       AND a.created_at >= ? AND a.created_at < ? GROUP BY id`,
    [start, end]
  )
  const counts = rr.map((r) => n(r.n))
  const balance = counts.length
    ? { min: Math.min(...counts), max: Math.max(...counts), spread: Math.max(...counts) - Math.min(...counts) }
    : { min: 0, max: 0, spread: 0 }

  return {
    period: { from: start, to: end, group, timezone: env.timezone },
    totals: {
      leads: n(totals.leads),
      converted: n(totals.converted),
      conversion_rate: rate(n(totals.converted), n(totals.leads)),
      contacted: n(totals.contacted),
    },
    series: series.map((r) => ({ period: r.period, leads: n(r.leads), converted: n(r.converted) })),
    by_source: bySource,
    by_campaign: byCampaign,
    by_course: byCourse,
    by_status: STAGES.map((s) => byStatus.find((b) => b.key === s) ?? { key: s, leads: 0, converted: 0, rate: 0 }),
    consultants,
    ageing: {
      buckets: [
        ['Under 1 day', n(ageing.d0)],
        ['1–3 days', n(ageing.d1_3)],
        ['3–7 days', n(ageing.d3_7)],
        ['1–2 weeks', n(ageing.d7_14)],
        ['2–4 weeks', n(ageing.d14_30)],
        ['Over 30 days', n(ageing.d30)],
      ].map(([label, count]) => ({ label, count })),
      untouched_new: n(ageing.untouched),
    },
    first_contact: {
      contacted: n(speed.contacted),
      avg_hours: speed.avg_min == null ? null : round1(n(speed.avg_min) / 60),
      within_1h_pct: rate(n(speed.within_1h), n(speed.contacted)),
      within_24h_pct: rate(n(speed.within_24h), n(speed.contacted)),
    },
    lms: Object.fromEntries(Object.entries(lms).map(([k, v]) => [k, n(v)])),
    discount_links: {
      generated: n(links.links_sent),
      redeemed: n(links.redeemed),
      redemption_rate: rate(n(links.redeemed), n(links.links_sent)),
      revenue: { USD: round1(n(links.revenue_usd)), INR: round1(n(links.revenue_inr)) },
    },
    operations: { ...Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, n(v)])), round_robin_balance: balance },
    exams: {
      ...Object.fromEntries(Object.entries(examTotals).map(([k, v]) => [k, n(v)])),
      pass_rate: rate(n(examTotals.passed), n(examTotals.passed) + n(examTotals.failed)),
      series: examSeries.map((r) => ({ period: r.period, completed: n(r.completed) })),
      coordinators: coordinatorRows.map((r) => ({
        id: r.id,
        name: r.name,
        active: Boolean(r.is_active),
        assigned: n(r.assigned),
        applications: n(r.applications),
        scheduled: n(r.scheduled),
        payment_alerts: n(r.payment_alerts),
        completed: n(r.completed),
        passed: n(r.passed),
        course_done: n(r.course_done),
      })),
    },
    // Ticket size earned in the period: the lead paid or reached Course Done
    ticket_revenue: Object.values(
      earnedRows.reduce((acc, r) => {
        const t = (acc[r.currency] ??= { currency: r.currency, leads: 0, amount: 0, paid_leads: 0, course_done_leads: 0 })
        t.leads += n(r.leads)
        t.amount = round1(t.amount + n(r.amount))
        t.paid_leads += n(r.paid_leads)
        t.course_done_leads += n(r.course_done_leads)
        return acc
      }, {})
    ),
    // Open applications: expected value by currency
    pipeline: pipelineRows.map((r) => ({ currency: r.currency, leads: n(r.leads), amount: round1(n(r.amount)) })),
  }
}

// ── CSV export (audited — it contains personal data) ─────────────────────

const csvCell = (v) => {
  if (v == null) return ''
  let s = v instanceof Date ? v.toISOString() : String(v)
  if (/^[=+\-@]/.test(s)) s = `'${s}` // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = (rows, columns) =>
  [columns.map(([, label]) => csvCell(label)).join(','), ...rows.map((r) => columns.map(([k]) => csvCell(r[k])).join(','))].join('\r\n')

export const exportLeads = async (req, q = {}) => {
  assertManager(req.user)
  const { start, end } = rangeOf(q)
  const [rows] = await pool.query(
    `SELECT l.id, l.created_at, l.name, l.phone, l.email, l.source,
            JSON_UNQUOTE(JSON_EXTRACT(l.source_meta, '$.campaign')) AS campaign, c.title AS course, l.stage,
            l.disposition_reason, u.name AS owner, l.first_contact_at, l.next_follow_up_at,
            l.ticket_size, l.ticket_currency, ec.name AS exam_coordinator, l.exam_status, l.exam_scheduled_at,
            l.exam_completed_at, l.exam_result, l.application_submitted, l.application_submitted_at,
            l.exam_done, l.payment_status, l.payment_done_at, l.payment_reference,
            (SELECT COUNT(*) FROM payments p WHERE p.lead_id = l.id AND p.status = 'success') AS sales
     FROM leads l LEFT JOIN courses c ON c.id = l.course_id LEFT JOIN users u ON u.id = l.owner_id
     LEFT JOIN users ec ON ec.id = l.exam_coordinator_id
     WHERE l.created_at >= ? AND l.created_at < ? AND l.archived_at IS NULL ORDER BY l.id`,
    [start, end]
  )
  await audit(req, { action: 'report.export', targetType: 'crm', details: { type: 'leads', from: start, to: end, rows: rows.length } })
  return toCsv(rows, [
    ['id', 'Lead ID'],
    ['created_at', 'Created (UTC)'],
    ['name', 'Name'],
    ['phone', 'Phone'],
    ['email', 'Email'],
    ['source', 'Source'],
    ['campaign', 'Campaign'],
    ['course', 'Course'],
    ['stage', 'Status'],
    ['disposition_reason', 'Reason'],
    ['owner', 'Owner'],
    ['first_contact_at', 'First contact (UTC)'],
    ['next_follow_up_at', 'Next follow-up (UTC)'],
    ['sales', 'Paid sales'],
    ['ticket_size', 'Ticket size'],
    ['ticket_currency', 'Ticket currency'],
    ['exam_coordinator', 'Exam coordinator'],
    ['application_submitted', 'Application submitted (1 = yes)'],
    ['application_submitted_at', 'Application submitted on'],
    ['exam_status', 'Exam status'],
    ['exam_scheduled_at', 'Exam date (UTC)'],
    ['exam_done', 'Exam done (1 = yes)'],
    ['exam_completed_at', 'Exam done on (UTC)'],
    ['exam_result', 'Exam result'],
    ['payment_status', 'Payment status'],
    ['payment_done_at', 'Payment done (UTC)'],
    ['payment_reference', 'Payment reference'],
  ])
}
