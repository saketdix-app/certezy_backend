// src/modules/reviews/reviews.queries.js

import { pool } from '../../config/db.js'

// ── Create review ──────────────────────────────────────────────────────────
const createReview = ({ user_id, course_id, rating, comment }) =>
  pool.query(
    `INSERT INTO reviews (user_id, course_id, rating, comment)
     VALUES (?, ?, ?, ?)`,
    [user_id, course_id, rating, comment ?? null]
  )

// ── Get review by user + course ────────────────────────────────────────────
const getReviewByUserAndCourse = (user_id, course_id) =>
  pool.query(`SELECT * FROM reviews WHERE user_id = ? AND course_id = ? LIMIT 1`, [user_id, course_id])

// ── Get review by ID ───────────────────────────────────────────────────────
const getReviewById = (id) => pool.query(`SELECT * FROM reviews WHERE id = ? LIMIT 1`, [id])

// ── Get all approved reviews by course ────────────────────────────────────
const getReviewsByCourseId = (course_id) =>
  pool.query(
    `SELECT
       r.id, r.rating, r.comment, r.created_at,
       u.name AS student_name
     FROM reviews r
     JOIN users u ON u.id = r.user_id
     WHERE r.course_id = ? AND r.is_approved = 1
     ORDER BY r.created_at DESC`,
    [course_id]
  )

// ── Get avg rating + count for a course ───────────────────────────────────
const getRatingStats = (course_id) =>
  pool.query(
    `SELECT
       ROUND(AVG(rating), 1) AS rating_avg,
       COUNT(*) AS rating_count
     FROM reviews
     WHERE course_id = ? AND is_approved = 1`,
    [course_id]
  )

// ── Admin — get all reviews ────────────────────────────────────────────────
const getAllReviews = ({ limit, offset, is_approved }) => {
  const conditions = []
  const values = []

  if (is_approved !== undefined) {
    conditions.push('r.is_approved = ?')
    values.push(is_approved)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  values.push(Number(limit), Number(offset))

  return pool.query(
    `SELECT
       r.id, r.rating, r.comment, r.is_approved, r.created_at,
       u.name  AS student_name,
       c.title AS course_title
     FROM reviews r
     JOIN users u   ON u.id = r.user_id
     JOIN courses c ON c.id = r.course_id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`,
    values
  )
}

// ── Count reviews ──────────────────────────────────────────────────────────
const countReviews = ({ is_approved }) => {
  const conditions = []
  const values = []

  if (is_approved !== undefined) {
    conditions.push('r.is_approved = ?')
    values.push(is_approved)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  return pool.query(`SELECT COUNT(*) AS total FROM reviews r ${where}`, values)
}

// ── Admin — approve/reject review ─────────────────────────────────────────
const updateApprovalStatus = (id, is_approved) =>
  pool.query(`UPDATE reviews SET is_approved = ? WHERE id = ?`, [is_approved, id])

// ── Delete review ──────────────────────────────────────────────────────────
const deleteReviewById = (id) => pool.query(`DELETE FROM reviews WHERE id = ?`, [id])

export {
  createReview,
  getReviewByUserAndCourse,
  getReviewById,
  getReviewsByCourseId,
  getRatingStats,
  getAllReviews,
  countReviews,
  updateApprovalStatus,
  deleteReviewById,
}
