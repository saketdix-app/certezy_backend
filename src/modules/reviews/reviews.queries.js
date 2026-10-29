// src/modules/reviews/reviews.queries.js

import { pool } from '../../config/db.js'

// ── Create review ──────────────────────────────────────────────────────────
const createReview = ({ user_id, course_id, rating, comment, is_approved }) =>
  pool.query(
    `INSERT INTO reviews (user_id, course_id, rating, comment, is_approved)
     VALUES (?, ?, ?, ?, ?)`,
    [user_id, course_id, rating, comment || null, is_approved ? 1 : 0]
  )

// ── Update a student's own review (goes back to moderation unless auto-approved)
const updateReview = (id, { rating, comment, is_approved }) =>
  pool.query(`UPDATE reviews SET rating = ?, comment = ?, is_approved = ? WHERE id = ?`, [
    rating,
    comment || null,
    is_approved ? 1 : 0,
    id,
  ])

// ── Get review by user + course ────────────────────────────────────────────
const getReviewByUserAndCourse = (user_id, course_id) =>
  pool.query(`SELECT * FROM reviews WHERE user_id = ? AND course_id = ? LIMIT 1`, [user_id, course_id])

// ── Get review by ID ───────────────────────────────────────────────────────
const getReviewById = (id) => pool.query(`SELECT * FROM reviews WHERE id = ? LIMIT 1`, [id])

// ── Approved reviews of a course (paginated, newest first) ─────────────────
const getReviewsByCourseId = (course_id, { limit, offset, rating }) => {
  const values = [course_id]
  let extra = ''
  if (rating) {
    extra = ' AND r.rating = ?'
    values.push(rating)
  }
  values.push(Number(limit), Number(offset))
  return pool.query(
    `SELECT
       r.id, r.rating, r.comment, r.created_at, r.updated_at,
       u.name AS student_name, u.avatar AS student_avatar
     FROM reviews r
     JOIN users u ON u.id = r.user_id
     WHERE r.course_id = ? AND r.is_approved = 1${extra}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ? OFFSET ?`,
    values
  )
}

// ── Average, count and 1–5 star distribution of approved reviews ──────────
const getRatingStats = (course_id) =>
  pool.query(
    `SELECT
       COALESCE(ROUND(AVG(rating), 1), 0) AS rating_avg,
       COUNT(*)                     AS rating_count,
       COALESCE(SUM(rating = 5), 0) AS r5,
       COALESCE(SUM(rating = 4), 0) AS r4,
       COALESCE(SUM(rating = 3), 0) AS r3,
       COALESCE(SUM(rating = 2), 0) AS r2,
       COALESCE(SUM(rating = 1), 0) AS r1
     FROM reviews
     WHERE course_id = ? AND is_approved = 1`,
    [course_id]
  )

// ── Admin — get all reviews ────────────────────────────────────────────────
const buildAdminFilter = ({ is_approved, course_id }) => {
  const conditions = []
  const values = []
  if (is_approved !== undefined && is_approved !== '') {
    conditions.push('r.is_approved = ?')
    values.push(Number(is_approved) ? 1 : 0)
  }
  if (course_id) {
    conditions.push('r.course_id = ?')
    values.push(course_id)
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values }
}

const getAllReviews = ({ limit, offset, ...filters }) => {
  const { where, values } = buildAdminFilter(filters)
  return pool.query(
    `SELECT
       r.id, r.course_id, r.rating, r.comment, r.is_approved, r.created_at,
       u.name  AS student_name,
       c.title AS course_title, c.slug AS course_slug
     FROM reviews r
     JOIN users u   ON u.id = r.user_id
     JOIN courses c ON c.id = r.course_id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, Number(limit), Number(offset)]
  )
}

// ── Count reviews ──────────────────────────────────────────────────────────
const countReviews = (filters) => {
  const { where, values } = buildAdminFilter(filters)
  return pool.query(`SELECT COUNT(*) AS total FROM reviews r ${where}`, values)
}

// ── Admin — approve/reject review ─────────────────────────────────────────
const updateApprovalStatus = (id, is_approved) =>
  pool.query(`UPDATE reviews SET is_approved = ? WHERE id = ?`, [is_approved ? 1 : 0, id])

// ── Delete review ──────────────────────────────────────────────────────────
const deleteReviewById = (id) => pool.query(`DELETE FROM reviews WHERE id = ?`, [id])

export {
  createReview,
  updateReview,
  getReviewByUserAndCourse,
  getReviewById,
  getReviewsByCourseId,
  getRatingStats,
  getAllReviews,
  countReviews,
  updateApprovalStatus,
  deleteReviewById,
}
