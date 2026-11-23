// src/modules/crm/actions.service.js
// 2.0 Phase 5 — CRM → LMS actions from a lead (PRD §7): create the student
// account, assign a course, send a discount link, issue a certificate.
//
//   • The lead must be visible to the actor (consultants: their own leads).
//   • Consultants and Sub-Admins need the matching permission
//     (can_assign_courses / can_send_discounts / can_issue_certificates);
//     Admins and Super Admins have them all.
//   • Certificates need course completion; only an Admin may override, with a
//     recorded reason (PRD §7.3).
//   • Consultants' discounts are capped by the CRM setting max_discount_pct.
//   • Every action is written to the lead timeline and the audit log (§7.4).

import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { assignCourses } from '../enrollments/enrollments.service.js'
import { createDiscountLink } from '../discounts/discounts.service.js'
import { getCompletionStatus, issueCertificate } from '../certificates/certificates.service.js'
import { issuePasswordLink } from '../auth/passwordReset.js'
import { sendStaffInviteJob } from '../../jobs/emailQueue.js'
import { getLead, normalizeEmail } from './leads.service.js'
import { isAdmin, isCrmManager } from '../../utils/access.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const MANAGERS = ['super_admin', 'admin']
const isManager = (actor) => isCrmManager(actor)
const INVITE_HOURS = 72
export const DEFAULT_MAX_DISCOUNT_PCT = 30

export const hasPermission = async (actor, key) => {
  if (isManager(actor)) return true
  const [[row]] = await pool.query(`SELECT ${key} AS allowed FROM admin_permissions WHERE user_id = ? LIMIT 1`, [actor.id])
  return Boolean(row?.allowed)
}

const requirePermission = async (req, key, action, leadId) => {
  if (await hasPermission(req.user, key)) return
  await audit(req, { action, targetType: 'lead', targetId: leadId, result: 'denied', details: { missing: key } })
  throw fail(403, "You don't have permission for this — ask an Admin")
}

const addActivity = (leadId, actorId, type, body, meta) =>
  pool.query('INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, ?, ?, ?, ?)', [
    leadId,
    actorId,
    type,
    body ?? null,
    meta ? JSON.stringify(meta) : null,
  ])

const requireStudent = (lead) => {
  if (!lead.user_id) throw fail(400, 'Create the student account first (or ask them to sign up with this email)')
}

export const getMaxDiscountPct = async () => {
  const [[row]] = await pool.query("SELECT value FROM crm_settings WHERE setting = 'max_discount_pct'")
  const n = Number(row?.value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DISCOUNT_PCT
}

/** Admins: the largest discount Consultants and Sub-Admins may give (PRD §7.2). */
export const setMaxDiscountPct = async (req, pct) => {
  if (!isAdmin(req.user)) throw fail(403, 'Only Admins change CRM settings')
  await pool.query(
    `INSERT INTO crm_settings (setting, value, updated_by) VALUES ('max_discount_pct', ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
    [String(pct), req.user.id]
  )
  await audit(req, { action: 'crm.setting', targetType: 'crm', details: { max_discount_pct: pct } })
  return { max_discount_pct: pct }
}

// ── Student account ───────────────────────────────────────────────────────

/** Create a student account from the lead and email a set-password link. */
export const createStudentAccount = async (req, id) => {
  const actor = req.user
  const lead = await getLead(actor, id)
  if (lead.user_id) throw fail(409, 'This lead already has a student account')
  const email = normalizeEmail(lead.email)
  if (!email) throw fail(400, 'Add the lead’s email first — the account signs in with it')

  const [[existing]] = await pool.query('SELECT id, role FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL LIMIT 1', [email])
  let userId = existing?.id
  if (!userId) {
    const [r] = await pool.query(
      `INSERT INTO users (name, email, mobile, password, role, oauth_provider, is_verified, is_active)
       VALUES (?, ?, ?, NULL, 'student', 'local', 1, 1)`,
      [lead.name, email, lead.phone || null]
    )
    userId = r.insertId
    const setUrl = await issuePasswordLink(userId, INVITE_HOURS * 60)
    await sendStaffInviteJob({ to: email, name: lead.name, roleLabel: 'Student', invitedBy: actor.name, setUrl, hours: INVITE_HOURS })
  }
  await pool.query('UPDATE leads SET user_id = ? WHERE id = ?', [userId, lead.id])
  await addActivity(lead.id, actor.id, 'student_account', null, { user_id: userId, existing: Boolean(existing) })
  await audit(req, { action: 'lead.student_account', targetType: 'lead', targetId: lead.id, details: { user_id: userId, existing: Boolean(existing) } })
  return getLead(actor, lead.id)
}

// ── Course assignment (PRD §7.1) ──────────────────────────────────────────

export const assignCourse = async (req, id, { course_id, note }) => {
  const actor = req.user
  const lead = await getLead(actor, id)
  await requirePermission(req, 'can_assign_courses', 'enrollment.assign', lead.id)
  requireStudent(lead)
  const courseId = Number(course_id || lead.course_id)
  if (!courseId) throw fail(400, 'Choose a course')

  const result = await assignCourses({ user_id: lead.user_id, course_ids: [courseId], note: note?.trim() || `From lead #${lead.id}`, assigned_by: actor.id })
  if (!result.assigned.length) {
    // Duplicate enrollment is refused, never created twice (PRD §7.1)
    throw fail(409, result.skipped[0]?.reason === 'Already enrolled' ? 'The student is already enrolled in this course' : result.skipped[0]?.reason ?? 'Could not assign the course')
  }
  await pool.query('UPDATE enrollments SET lead_id = ? WHERE id = ?', [lead.id, result.assigned[0].enrollment_id])
  await addActivity(lead.id, actor.id, 'course_assigned', note?.trim() || null, { course_id: courseId, enrollment_id: result.assigned[0].enrollment_id })
  await audit(req, { action: 'enrollment.assign', targetType: 'lead', targetId: lead.id, details: { user_id: lead.user_id, course_id: courseId } })
  return getLead(actor, lead.id)
}

// ── Discount links (PRD §7.2) ─────────────────────────────────────────────

export const sendDiscount = async (req, id, { course_id, discount_price, discount_price_inr, expiry_hours }) => {
  const actor = req.user
  const lead = await getLead(actor, id)
  await requirePermission(req, 'can_send_discounts', 'discount.create', lead.id)
  const courseId = Number(course_id || lead.course_id)
  if (!courseId) throw fail(400, 'Choose a course')
  if (!lead.user_id && !normalizeEmail(lead.email)) throw fail(400, 'Add the lead’s email first — the link is sent by email')

  // Central limit for non-Admins (PRD §7.2: maximum values centrally configurable)
  if (!isManager(actor)) {
    const [[course]] = await pool.query('SELECT price FROM courses WHERE id = ?', [courseId])
    const max = await getMaxDiscountPct()
    const pct = course ? ((Number(course.price) - Number(discount_price)) / Number(course.price)) * 100 : 0
    if (pct > max + 0.001) throw fail(400, `Discounts above ${max}% need an Admin`)
  }

  const link = await createDiscountLink(actor.id, {
    ...(lead.user_id ? { user_id: lead.user_id } : { email: lead.email }),
    course_id: courseId,
    discount_price,
    discount_price_inr,
    expiry_hours,
  })
  await pool.query('UPDATE discount_links SET lead_id = ? WHERE token = ?', [lead.id, link.token])
  await addActivity(lead.id, actor.id, 'discount_sent', null, {
    course_id: courseId,
    discount_price: link.discount_price,
    discount_pct: link.discount_pct,
    expires_at: link.expires_at,
  })
  await audit(req, { action: 'discount.create', targetType: 'lead', targetId: lead.id, details: { course_id: courseId, discount_pct: link.discount_pct } })
  return { lead: await getLead(actor, lead.id), link }
}

/** Withdraw a discount link (Admins). It can't be used afterwards. */
export const revokeDiscount = async (req, linkId, { reason }) => {
  if (!isManager(req.user)) throw fail(403, 'Only Admins can withdraw discount links')
  const [[link]] = await pool.query('SELECT * FROM discount_links WHERE id = ?', [linkId])
  if (!link) throw fail(404, 'Discount link not found')
  if (link.is_used) throw fail(409, 'This link was already used to pay')
  if (link.revoked_at) throw fail(409, 'This link was already withdrawn')
  if (!reason?.trim()) throw fail(400, 'Give a reason')
  await pool.query('UPDATE discount_links SET revoked_at = UTC_TIMESTAMP(), revoked_by = ?, revoke_reason = ? WHERE id = ?', [
    req.user.id,
    reason.trim(),
    link.id,
  ])
  if (link.lead_id) await addActivity(link.lead_id, req.user.id, 'discount_revoked', reason.trim(), { link_id: link.id })
  await audit(req, { action: 'discount.revoke', targetType: 'discount', targetId: link.id, details: { reason: reason.trim(), lead_id: link.lead_id } })
  return { revoked: true }
}

// ── Certificates (PRD §7.3) ───────────────────────────────────────────────

export const issueLeadCertificate = async (req, id, { course_id, override_reason }) => {
  const actor = req.user
  const lead = await getLead(actor, id)
  await requirePermission(req, 'can_issue_certificates', 'certificate.issue', lead.id)
  requireStudent(lead)
  const courseId = Number(course_id || lead.course_id)
  if (!courseId) throw fail(400, 'Choose a course')

  const [[existing]] = await pool.query('SELECT id, certificate_no FROM certificates WHERE user_id = ? AND course_id = ? LIMIT 1', [lead.user_id, courseId])
  if (existing) throw fail(409, `Already issued (${existing.certificate_no})`)

  const status = await getCompletionStatus(lead.user_id, courseId)
  const why = override_reason?.trim()
  if (!status.enrolled) throw fail(400, 'The student is not enrolled in this course')
  if (!status.complete) {
    if (!why) throw fail(400, `Not eligible yet — ${status.reason ?? 'the course is not complete'}`)
    if (!isManager(actor)) {
      await audit(req, { action: 'certificate.override', targetType: 'lead', targetId: lead.id, result: 'denied', details: { course_id: courseId } })
      throw fail(403, 'Only an Admin can issue a certificate before the course is complete')
    }
  }

  const cert = await issueCertificate(lead.user_id, courseId)
  await pool.query('UPDATE certificates SET issued_by = ?, lead_id = ?, override_reason = ? WHERE id = ?', [
    actor.id,
    lead.id,
    status.complete ? null : why,
    cert.id,
  ])
  await addActivity(lead.id, actor.id, 'certificate_issued', status.complete ? null : `Override: ${why}`, { course_id: courseId, certificate_no: cert.certificate_no })
  await audit(req, {
    action: status.complete ? 'certificate.issue' : 'certificate.override',
    targetType: 'lead',
    targetId: lead.id,
    details: { course_id: courseId, certificate_no: cert.certificate_no, override_reason: status.complete ? undefined : why },
  })
  return { lead: await getLead(actor, lead.id), certificate: cert }
}

// ── Lists for the consultant workspace (own) / Admins (all) ──────────────

const scope = (actor, column) => (isManager(actor) ? { sql: '1 = 1', values: [] } : { sql: `${column} = ?`, values: [actor.id] })

export const listDiscountLinks = async (actor) => {
  const s = scope(actor, 'd.created_by')
  const [rows] = await pool.query(
    `SELECT d.id, d.lead_id, d.email, d.discount_price, d.discount_price_inr, d.original_price, d.discount_pct,
            d.is_used, d.used_at, d.expires_at, d.created_at, d.click_count, d.first_clicked_at, d.revoked_at, d.revoke_reason,
            c.title AS course_title, l.name AS lead_name, u.name AS created_by_name
     FROM discount_links d
     JOIN courses c ON c.id = d.course_id
     LEFT JOIN leads l ON l.id = d.lead_id
     LEFT JOIN users u ON u.id = d.created_by
     WHERE ${s.sql}
     ORDER BY d.id DESC LIMIT 300`,
    s.values
  )
  const now = Date.now()
  return rows.map((r) => ({
    ...r,
    state: r.is_used ? 'redeemed' : r.revoked_at ? 'revoked' : new Date(r.expires_at).getTime() < now ? 'expired' : r.click_count > 0 ? 'clicked' : 'generated',
  }))
}

export const listAssignments = async (actor) => {
  const s = scope(actor, 'e.assigned_by')
  const [rows] = await pool.query(
    `SELECT e.id, e.lead_id, e.enrolled_at AS created_at, e.note, e.progress, c.title AS course_title,
            st.name AS student_name, st.email AS student_email, u.name AS assigned_by_name
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN users st ON st.id = e.user_id
     LEFT JOIN users u ON u.id = e.assigned_by
     WHERE e.assigned_by IS NOT NULL AND ${s.sql}
     ORDER BY e.id DESC LIMIT 300`,
    s.values
  )
  return rows
}

export const listIssuedCertificates = async (actor) => {
  const s = scope(actor, 'ct.issued_by')
  const [rows] = await pool.query(
    `SELECT ct.id, ct.lead_id, ct.certificate_no, ct.issued_at, ct.pdf_url, ct.override_reason,
            c.title AS course_title, st.name AS student_name, u.name AS issued_by_name
     FROM certificates ct
     JOIN courses c ON c.id = ct.course_id
     JOIN users st ON st.id = ct.user_id
     LEFT JOIN users u ON u.id = ct.issued_by
     WHERE ct.issued_by IS NOT NULL AND ${s.sql}
     ORDER BY ct.id DESC LIMIT 300`,
    s.values
  )
  return rows
}
