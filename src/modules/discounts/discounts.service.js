// src/modules/discounts/discounts.service.js

import { pool } from '../../config/db.js'
import * as queries from './discounts.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import { findById, findByEmail } from '../auth/auth.queries.js'
import env from '../../config/env.js'
import { generateUUID } from '../../utils/generate.js'
import { sendDiscountJob } from '../../jobs/emailQueue.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const offerUrlFor = (token) => `${env.frontendUrl}/offer/${token}`

// "saket@gmail.com" → "s****@gmail.com" (public offer page hint)
const maskEmail = (email = '') => {
  const [local, domain] = email.split('@')
  if (!domain) return ''
  return `${local[0]}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`
}

// ── Create discount link (admin) ───────────────────────────────────────────
// For a registered student (user_id) or for any email address (email). An email
// that already has an account is linked to it; otherwise the link waits for
// whoever signs up with that email.
const createDiscountLink = async (
  created_by,
  { user_id, email, course_id, discount_price, expiry_hours }
) => {
  // Course exists check
  const [courseRows] = await courseQueries.getCourseById(course_id)
  if (!courseRows.length) throw fail(404, 'Course not found')
  const course = courseRows[0]

  let student = null
  let targetEmail = null
  if (user_id) {
    student = await findById(user_id)
    if (!student) throw fail(404, 'Student not found')
  } else {
    targetEmail = String(email ?? '')
      .trim()
      .toLowerCase()
    if (!EMAIL_RE.test(targetEmail)) throw fail(400, 'Enter a valid email address')
    student = await findByEmail(targetEmail)
  }

  // Student already enrolled check
  if (student) {
    const [enrollCheck] = await pool_query_check(student.id, course_id)
    if (enrollCheck.length) throw fail(409, 'This student is already enrolled in this course')
  }

  // Discount price validation
  const price = Number(course.price)
  const discountPrice = Number(discount_price)
  if (!(discountPrice >= 0) || discountPrice >= price) {
    throw fail(400, 'Discount price must be less than the course price')
  }

  // Discount percentage calculate karo
  const discount_pct = parseFloat((((price - discountPrice) / price) * 100).toFixed(2))

  // Expiry calculate karo
  const expires_at = new Date(Date.now() + (Number(expiry_hours) || 24) * 60 * 60 * 1000)

  // Token generate karo
  const token = generateUUID()

  // DB mein save karo
  await queries.createDiscountLink({
    token,
    user_id: student?.id ?? null,
    email: student ? student.email.toLowerCase() : targetEmail,
    course_id,
    original_price: price,
    discount_price: discountPrice,
    discount_pct,
    created_by,
    expires_at,
  })

  const to = student?.email ?? targetEmail
  const offer_url = offerUrlFor(token)

  // Email bhejo (background job)
  await sendDiscountJob({
    to,
    name: student?.name ?? null,
    courseTitle: course.title,
    originalPrice: price,
    discountPrice,
    discountPct: discount_pct,
    token,
    offerUrl: offer_url,
    expiresAt: expires_at,
  })

  return {
    token,
    offer_url,
    student_email: to,
    is_registered: Boolean(student),
    course_title: course.title,
    original_price: price,
    discount_price: discountPrice,
    discount_pct,
    expires_at,
  }
}

// ── Public — offer details for the landing page (no login) ────────────────
const getOffer = async (token) => {
  const [rows] = await queries.getOfferByToken(token)
  if (!rows.length) throw fail(404, 'This offer link is not valid')
  const o = rows[0]
  const status = o.is_used ? 'used' : new Date() > new Date(o.expires_at) ? 'expired' : 'active'
  return {
    status,
    course: {
      id: o.course_id,
      title: o.course_title,
      slug: o.course_slug,
      thumbnail: o.course_thumbnail,
      short_desc: o.course_short_desc,
    },
    original_price: o.original_price,
    discount_price: o.discount_price,
    discount_pct: o.discount_pct,
    expires_at: o.expires_at,
    email_hint: maskEmail(o.email ?? ''),
  }
}

// ── Verify discount token (student checkout se pehle) ─────────────────────
const verifyDiscountToken = async (token, user_id) => {
  const [rows] = await queries.getDiscountByToken(token)
  if (!rows.length) throw fail(404, 'Invalid discount link')

  const discount = rows[0]

  // Only for the student it was created for — by account, or by email for
  // links sent to an address that had no account yet
  let allowed = discount.user_id === user_id
  if (!allowed && discount.user_id == null && discount.email) {
    const user = await findById(user_id)
    allowed = Boolean(user) && user.email.toLowerCase() === discount.email.toLowerCase()
  }
  if (!allowed) throw fail(403, 'This discount link was sent to a different email address')

  // Already used check
  if (discount.is_used) throw fail(410, 'Discount link already used')

  // Expiry check
  if (new Date() > new Date(discount.expires_at)) throw fail(410, 'Discount link has expired')

  return {
    discount_link_id: discount.id,
    course_id: discount.course_id,
    original_price: discount.original_price,
    discount_price: discount.discount_price,
    discount_pct: discount.discount_pct,
    expires_at: discount.expires_at,
  }
}

// ── Mark discount as used (payment verify ke baad call hoga) ──────────────
const markDiscountUsed = async (discount_link_id, user_id = null) => {
  await queries.markDiscountUsed(discount_link_id, user_id)
}

// ── Admin — get all discount links ─────────────────────────────────────────
const getAllDiscounts = async ({ page = 1, limit = 20 } = {}) => {
  const offset = (page - 1) * limit

  const [rows] = await queries.getAllDiscounts({ limit, offset })
  const [count] = await queries.countDiscounts()

  return {
    discounts: rows,
    pagination: {
      total: count[0].total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(count[0].total / limit),
    },
  }
}

// ── Internal helper — enrollment check ────────────────────────────────────
const pool_query_check = (user_id, course_id) =>
  pool.query('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? LIMIT 1', [user_id, course_id])

export { createDiscountLink, getOffer, verifyDiscountToken, markDiscountUsed, getAllDiscounts }
