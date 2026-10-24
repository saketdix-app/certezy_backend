// src/modules/discounts/discounts.service.js

import { pool } from '../../config/db.js'
import * as queries from './discounts.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import { findById } from '../auth/auth.queries.js'
import { generateUUID } from '../../utils/generate.js'
import { sendDiscountJob } from '../../jobs/emailQueue.js'

// ── Create discount link (admin) ───────────────────────────────────────────
const createDiscountLink = async (created_by, { user_id, course_id, discount_price, expiry_hours }) => {
  // Course exists check
  const [courseRows] = await courseQueries.getCourseById(course_id)
  if (!courseRows.length) {
    const err = new Error('Course not found')
    err.statusCode = 404
    throw err
  }
  const course = courseRows[0]

  // Student exists check
  const student = await findById(user_id)
  if (!student) {
    const err = new Error('Student not found')
    err.statusCode = 404
    throw err
  }

  // Student already enrolled check
  const [enrollCheck] = await pool_query_check(user_id, course_id)
  if (enrollCheck.length) {
    const err = new Error('Student is already enrolled in this course')
    err.statusCode = 409
    throw err
  }

  // Discount price validation
  if (discount_price >= course.price) {
    const err = new Error('Discount price must be less than original price')
    err.statusCode = 400
    throw err
  }

  // Discount percentage calculate karo
  const discount_pct = parseFloat((((course.price - discount_price) / course.price) * 100).toFixed(2))

  // Expiry calculate karo
  const expires_at = new Date(Date.now() + (expiry_hours ?? 24) * 60 * 60 * 1000)

  // Token generate karo
  const token = generateUUID()

  // DB mein save karo
  await queries.createDiscountLink({
    token,
    user_id,
    course_id,
    original_price: course.price,
    discount_price,
    discount_pct,
    created_by,
    expires_at,
  })

  // Email bhejo student ko (background job)
  await sendDiscountJob({
    to: student.email,
    name: student.name,
    courseTitle: course.title,
    originalPrice: course.price,
    discountPrice: discount_price,
    token,
    expiresAt: expires_at,
  })

  return {
    token,
    student_email: student.email,
    course_title: course.title,
    original_price: course.price,
    discount_price,
    discount_pct,
    expires_at,
  }
}

// ── Verify discount token (student checkout se pehle) ─────────────────────
const verifyDiscountToken = async (token, user_id) => {
  const [rows] = await queries.getDiscountByToken(token)
  if (!rows.length) {
    const err = new Error('Invalid discount link')
    err.statusCode = 404
    throw err
  }

  const discount = rows[0]

  // Sirf us student ke liye hai jo token mila tha
  if (discount.user_id !== user_id) {
    const err = new Error('This discount link is not for you')
    err.statusCode = 403
    throw err
  }

  // Already used check
  if (discount.is_used) {
    const err = new Error('Discount link already used')
    err.statusCode = 410
    throw err
  }

  // Expiry check
  if (new Date() > new Date(discount.expires_at)) {
    const err = new Error('Discount link has expired')
    err.statusCode = 410
    throw err
  }

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
const markDiscountUsed = async (discount_link_id) => {
  await queries.markDiscountUsed(discount_link_id)
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

export { createDiscountLink, verifyDiscountToken, markDiscountUsed, getAllDiscounts }
