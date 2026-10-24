// src/modules/enrollments/enrollments.queries.js

import { pool } from '../../config/db.js'

// ── Get all enrollments of a student ──────────────────────────────────────
const getEnrollmentsByUserId = (user_id) =>
  pool.query(
    `SELECT
       e.id, e.user_id, e.course_id, e.payment_id,
       e.enrolled_at, e.completed_at, e.progress,
       c.title, c.slug, c.thumbnail, c.level, c.language,
       c.total_lessons, c.total_duration, c.certificate_eligible,
       cat.name AS category_name
     FROM enrollments e
     JOIN courses c   ON c.id = e.course_id
     JOIN categories cat ON cat.id = c.category_id
     WHERE e.user_id = ?
     ORDER BY e.enrolled_at DESC`,
    [user_id]
  )

// ── Get single enrollment by user + course ────────────────────────────────
const getEnrollment = (user_id, course_id) =>
  pool.query(
    `SELECT * FROM enrollments
     WHERE user_id = ? AND course_id = ? LIMIT 1`,
    [user_id, course_id]
  )

// ── Get enrollment by ID ───────────────────────────────────────────────────
const getEnrollmentById = (id) => pool.query(`SELECT * FROM enrollments WHERE id = ? LIMIT 1`, [id])

// ── Create enrollment (called internally by payment service) ──────────────
const createEnrollment = ({ user_id, course_id, payment_id }) =>
  pool.query(
    `INSERT INTO enrollments (user_id, course_id, payment_id)
     VALUES (?, ?, ?)`,
    [user_id, course_id, payment_id]
  )

// ── Update progress ────────────────────────────────────────────────────────
const updateProgress = (user_id, course_id, progress) =>
  pool.query(`UPDATE enrollments SET progress = ? WHERE user_id = ? AND course_id = ?`, [
    progress,
    user_id,
    course_id,
  ])

// ── Mark course as completed ───────────────────────────────────────────────
const markCompleted = (user_id, course_id) =>
  pool.query(
    `UPDATE enrollments
     SET completed_at = CURRENT_TIMESTAMP, progress = 100
     WHERE user_id = ? AND course_id = ?`,
    [user_id, course_id]
  )

// ── Admin — get all enrollments (with filters) ────────────────────────────
const getAllEnrollments = ({ limit, offset, course_id, user_id }) => {
  const conditions = []
  const values = []

  if (course_id) {
    conditions.push('e.course_id = ?')
    values.push(course_id)
  }
  if (user_id) {
    conditions.push('e.user_id = ?')
    values.push(user_id)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  values.push(Number(limit), Number(offset))

  return pool.query(
    `SELECT
       e.id, e.user_id, e.course_id, e.payment_id,
       e.enrolled_at, e.completed_at, e.progress,
       u.name AS student_name, u.email AS student_email,
       c.title AS course_title, c.slug AS course_slug
     FROM enrollments e
     JOIN users u   ON u.id = e.user_id
     JOIN courses c ON c.id = e.course_id
     ${where}
     ORDER BY e.enrolled_at DESC
     LIMIT ? OFFSET ?`,
    values
  )
}

// ── Admin — count enrollments (for pagination) ────────────────────────────
const countEnrollments = ({ course_id, user_id }) => {
  const conditions = []
  const values = []

  if (course_id) {
    conditions.push('e.course_id = ?')
    values.push(course_id)
  }
  if (user_id) {
    conditions.push('e.user_id = ?')
    values.push(user_id)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  return pool.query(`SELECT COUNT(*) AS total FROM enrollments e ${where}`, values)
}

export {
  getEnrollmentsByUserId,
  getEnrollment,
  getEnrollmentById,
  createEnrollment,
  updateProgress,
  markCompleted,
  getAllEnrollments,
  countEnrollments,
}
