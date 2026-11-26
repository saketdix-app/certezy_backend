// src/modules/crm/automation.service.js
// 2.0 Phase 8 — CRM automations. Each can be switched off by an Admin
// (crm_settings). They only move a lead forward, never back, and every
// automatic change is written to the lead timeline as "Automation".
//
//   auto_stage_on_payment     paid sale → lead moves to Application (if earlier)
//   auto_course_done          course completed → lead moves to Course Done
//   abandoned_checkout_nudge  checkout started, unpaid after 1 h → owner told
//   follow_up_reminders       follow-up due in ≤ 15 min → owner reminded
//
// The scheduled ones claim each row with a conditional UPDATE first, so two
// server processes never send the same nudge or reminder twice.

import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { notify } from '../../utils/notify.js'
import { fmtIstTime } from '../../utils/ist.js'

export const AUTOMATIONS = ['auto_stage_on_payment', 'auto_course_done', 'abandoned_checkout_nudge', 'follow_up_reminders']
const EARLY_STAGES = ['backlog', 'new', 'attempting_contact', 'in_conversation', 'no_response', 'on_hold']
const ABANDONED_AFTER_MIN = 60
const REMIND_BEFORE_MIN = 15

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

export const getAutomations = async () => {
  const [rows] = await pool.query('SELECT setting, value FROM crm_settings WHERE setting IN (?)', [AUTOMATIONS])
  const out = Object.fromEntries(AUTOMATIONS.map((k) => [k, true])) // default on
  for (const r of rows) out[r.setting] = r.value === '1'
  return out
}

const isOn = async (key) => (await getAutomations())[key]

export const setAutomations = async (req, values) => {
  if (!['super_admin', 'admin'].includes(req.user?.role)) throw fail(403, 'Only Admins change automations')
  for (const key of AUTOMATIONS) {
    if (values[key] === undefined) continue
    await pool.query(
      `INSERT INTO crm_settings (setting, value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
      [key, values[key] ? '1' : '0', req.user.id]
    )
  }
  await audit(req, { action: 'crm.automations', targetType: 'crm', details: values })
  return getAutomations()
}

const autoMove = async (leadId, from, to, note) => {
  const [r] = await pool.query(
    `UPDATE leads SET stage = ?, prior_stage = stage, stage_reason = ?, stage_changed_at = UTC_TIMESTAMP()
     WHERE id = ? AND stage = ?`,
    [to, note, leadId, from]
  )
  if (!r.affectedRows) return false // someone moved it meanwhile
  await pool.query("INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, NULL, 'status_change', ?, ?)", [
    leadId,
    note,
    JSON.stringify({ from, to, automation: true }),
  ])
  await audit(null, { action: 'lead.stage_change', targetType: 'lead', targetId: leadId, details: { from, to, automation: true } })
  return true
}

/** After a sale is credited (sales.service). Never throws. */
export const onSale = async (leadId) => {
  try {
    if (!(await isOn('auto_stage_on_payment'))) return false
    const [[lead]] = await pool.query('SELECT id, stage FROM leads WHERE id = ?', [leadId])
    if (!lead || !EARLY_STAGES.includes(lead.stage)) return false
    return await autoMove(lead.id, lead.stage, 'application', 'Automation: payment received')
  } catch (err) {
    console.error('Automation onSale failed:', err.message)
    return false
  }
}

/** When a student completes a course (certificates.service). Never throws. */
export const onCourseCompleted = async (userId, courseId) => {
  try {
    if (!(await isOn('auto_course_done'))) return 0
    const [leads] = await pool.query(
      `SELECT id, stage, owner_id, name FROM leads
       WHERE user_id = ? AND (course_id = ? OR course_id IS NULL) AND archived_at IS NULL
         AND stage NOT IN ('course_done', 'not_interested', 'junk')`,
      [userId, courseId]
    )
    let moved = 0
    for (const l of leads) {
      if (await autoMove(l.id, l.stage, 'course_done', 'Automation: course completed')) {
        moved++
        if (l.owner_id) {
          await notify(l.owner_id, { type: 'course_done', title: `${l.name} completed the course 🎓`, link: `/consultant/leads?lead=${l.id}` })
        }
      }
    }
    return moved
  } catch (err) {
    console.error('Automation onCourseCompleted failed:', err.message)
    return 0
  }
}

/** Checkout started but not paid after an hour → tell the lead's owner once. */
export const runAbandonedCheckout = async () => {
  if (!(await isOn('abandoned_checkout_nudge'))) return 0
  const [rows] = await pool.query(
    `SELECT p.id, p.course_id, p.amount, p.currency, l.id AS lead_id, l.name, l.owner_id, c.title
     FROM payments p
     JOIN leads l ON l.user_id = p.user_id AND l.archived_at IS NULL AND l.owner_id IS NOT NULL
     LEFT JOIN courses c ON c.id = p.course_id
     WHERE p.status = 'pending' AND p.nudged_at IS NULL
       AND p.created_at < UTC_TIMESTAMP() - INTERVAL ${ABANDONED_AFTER_MIN} MINUTE
       AND p.created_at > UTC_TIMESTAMP() - INTERVAL 3 DAY
       AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = p.user_id AND e.course_id = p.course_id)
     LIMIT 100`
  )
  let sent = 0
  for (const r of rows) {
    const [claim] = await pool.query('UPDATE payments SET nudged_at = UTC_TIMESTAMP() WHERE id = ? AND nudged_at IS NULL', [r.id])
    if (!claim.affectedRows) continue
    await pool.query("INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, NULL, 'checkout_abandoned', NULL, ?)", [
      r.lead_id,
      JSON.stringify({ payment_id: r.id, course: r.title, amount: Number(r.amount), currency: r.currency }),
    ])
    await notify(r.owner_id, {
      type: 'checkout_abandoned',
      title: `${r.name} started checkout but didn't pay`,
      body: `${r.title ?? 'Course'} — a quick call or a discount link may help`,
      link: `/consultant/leads?lead=${r.lead_id}`,
    })
    sent++
  }
  return sent
}

/** Follow-ups due within the next 15 minutes → remind the owner once (PRD §5 reminder state). */
export const runFollowUpReminders = async () => {
  if (!(await isOn('follow_up_reminders'))) return 0
  const [rows] = await pool.query(
    `SELECT f.id, f.type, f.due_at, f.owner_id, l.id AS lead_id, l.name
     FROM lead_follow_ups f JOIN leads l ON l.id = f.lead_id
     WHERE f.status = 'pending' AND f.reminded_at IS NULL AND f.owner_id IS NOT NULL
       AND f.due_at <= UTC_TIMESTAMP() + INTERVAL ${REMIND_BEFORE_MIN} MINUTE
       AND f.due_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR
     LIMIT 200`
  )
  let sent = 0
  for (const f of rows) {
    const [claim] = await pool.query('UPDATE lead_follow_ups SET reminded_at = UTC_TIMESTAMP() WHERE id = ? AND reminded_at IS NULL', [f.id])
    if (!claim.affectedRows) continue
    await notify(f.owner_id, {
      type: 'follow_up_due',
      title: `Follow-up due: ${f.name}`,
      body: `${f.type} at ${fmtIstTime(f.due_at)}`,
      link: `/consultant/leads?lead=${f.lead_id}`,
    })
    sent++
  }
  return sent
}
