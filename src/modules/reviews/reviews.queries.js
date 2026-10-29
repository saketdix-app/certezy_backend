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

// Display name + date shared by public and admin listings. Admin-entered
// reviews have no user row, so the name/date come from the review itself.
const DISPLAY_COLUMNS = `
  COALESCE(r.reviewer_name, u.name, 'Learner') AS student_name,
  u.avatar AS student_avatar,
  r.source, r.source_note,
  COALESCE(r.reviewed_at, r.created_at) AS review_date`

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
    `SELECT r.id, r.rating, r.comment, r.created_at, r.updated_at, ${DISPLAY_COLUMNS}
     FROM reviews r
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.course_id = ? AND r.is_approved = 1${extra}
     ORDER BY review_date DESC, r.id DESC
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
const buildAdminFilter = ({ is_approved, course_id, source, search }) => {
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
  if (source === 'admin') {
    conditions.push("r.source <> 'platform'")
  } else if (source) {
    conditions.push('r.source = ?')
    values.push(source)
  }
  if (search) {
    conditions.push('(COALESCE(r.reviewer_name, u.name) LIKE ? OR c.title LIKE ? OR r.comment LIKE ?)')
    values.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values }
}

const ADMIN_FROM = `
  FROM reviews r
  LEFT JOIN users u ON u.id = r.user_id
  JOIN courses c    ON c.id = r.course_id
  LEFT JOIN users a ON a.id = r.created_by`

const getAllReviews = ({ limit, offset, ...filters }) => {
  const { where, values } = buildAdminFilter(filters)
  return pool.query(
    `SELECT
       r.id, r.user_id, r.course_id, r.rating, r.comment, r.is_approved, r.created_at,
       r.reviewer_name, r.reviewed_at, ${DISPLAY_COLUMNS},
       c.title AS course_title, c.slug AS course_slug,
       a.name  AS created_by_name
     ${ADMIN_FROM}
     ${where}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ? OFFSET ?`,
    [...values, Number(limit), Number(offset)]
  )
}

// ── Count reviews ──────────────────────────────────────────────────────────
const countReviews = (filters) => {
  const { where, values } = buildAdminFilter(filters)
  return pool.query(`SELECT COUNT(*) AS total ${ADMIN_FROM} ${where}`, values)
}

// ── Admin — enter a genuine review collected outside the site ─────────────
const createAdminReview = (r, executor = pool) =>
  executor.query(
    `INSERT INTO reviews
       (user_id, course_id, rating, comment, is_approved, source, reviewer_name, source_note, reviewed_at, created_by)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.course_id,
      r.rating,
      r.comment || null,
      r.is_approved ? 1 : 0,
      r.source,
      r.reviewer_name,
      r.source_note || null,
      r.reviewed_at || null,
      r.created_by ?? null,
    ]
  )

const updateAdminReview = (id, r, executor = pool) =>
  executor.query(
    `UPDATE reviews
     SET course_id = ?, rating = ?, comment = ?, is_approved = ?, source = ?,
         reviewer_name = ?, source_note = ?, reviewed_at = ?
     WHERE id = ? AND source <> 'platform'`,
    [
      r.course_id,
      r.rating,
      r.comment || null,
      r.is_approved ? 1 : 0,
      r.source,
      r.reviewer_name,
      r.source_note || null,
      r.reviewed_at || null,
      id,
    ]
  )

// Used by CSV import to avoid duplicating the same review on re-import
const findAdminReview = async ({ course_id, reviewer_name, comment }, executor = pool) => {
  const [rows] = await executor.query(
    `SELECT id FROM reviews
     WHERE course_id = ? AND source <> 'platform' AND reviewer_name = ? AND COALESCE(comment, '') = ?
     LIMIT 1`,
    [course_id, reviewer_name, comment || '']
  )
  return rows[0] || null
}

// ── Admin — approve/reject review ─────────────────────────────────────────
const updateApprovalStatus = (id, is_approved) =>
  pool.query(`UPDATE reviews SET is_approved = ? WHERE id = ?`, [is_approved ? 1 : 0, id])

// ── Delete review ──────────────────────────────────────────────────────────
const deleteReviewById = (id) => pool.query(`DELETE FROM reviews WHERE id = ?`, [id])

export {
  createReview,
  createAdminReview,
  updateAdminReview,
  findAdminReview,
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
