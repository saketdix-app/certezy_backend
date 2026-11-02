// src/modules/enrollments/enrollments.queries.js

import { pool } from '../../config/db.js'

// ── Get all enrollments of a student ──────────────────────────────────────
const getEnrollmentsByUserId = (user_id) =>
  pool.query(
    `SELECT
       e.id, e.user_id, e.course_id, e.payment_id, e.source,
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
const createEnrollment = ({ user_id, course_id, payment_id, source = 'purchase' }) =>
  pool.query(
    `INSERT INTO enrollments (user_id, course_id, payment_id, source)
     VALUES (?, ?, ?, ?)`,
    [user_id, course_id, payment_id ?? null, source]
  )

// ── Create a free enrollment assigned by an admin / sub-admin ─────────────
const createAssignedEnrollment = ({ user_id, course_id, assigned_by, note }) =>
  pool.query(
    `INSERT INTO enrollments (user_id, course_id, payment_id, source, assigned_by, note)
     VALUES (?, ?, NULL, 'admin', ?, ?)`,
    [user_id, course_id, assigned_by, note || null]
  )

// ── Admin — one user's enrollments with how they were granted ─────────────
const getUserEnrollmentsDetailed = (user_id) =>
  pool.query(
    `SELECT
       e.id, e.user_id, e.course_id, e.payment_id, e.source, e.note,
       e.enrolled_at, e.completed_at, e.progress,
       c.title AS course_title, c.slug AS course_slug, c.thumbnail, c.price, c.status AS course_status,
       a.name AS assigned_by_name
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     LEFT JOIN users a ON a.id = e.assigned_by
     WHERE e.user_id = ?
     ORDER BY e.enrolled_at DESC`,
    [user_id]
  )

// ── Admin — revoke (delete) an enrollment ─────────────────────────────────
const deleteEnrollmentById = (id) => pool.query(`DELETE FROM enrollments WHERE id = ?`, [id])

// ── Courses an admin can assign (anything not archived) ───────────────────
const getAssignableCourses = ({ search }) => {
  const values = []
  let where = "WHERE c.status != 'archived'"
  if (search) {
    where += ' AND c.title LIKE ?'
    values.push(`%${search}%`)
  }
  return pool.query(
    `SELECT c.id, c.title, c.slug, c.thumbnail, c.price, c.status, c.level
     FROM courses c
     ${where}
     ORDER BY c.title ASC
     LIMIT 200`,
    values
  )
}

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

// ── Admin — enrollment list / stats / export ──────────────────────────────
// Status of an enrollment:
//   completed   — finished (completed_at set or progress 100)
//   in_progress — opened at least one lesson or has some progress
//   not_started — enrolled but never opened a lesson
// "inactive" = in progress, but no lesson opened for INACTIVE_DAYS days.
const INACTIVE_DAYS = 14

const LAST_ACTIVITY_JOIN = `
  LEFT JOIN (
    SELECT lp.user_id, s.course_id, MAX(lp.last_watched) AS last_activity
    FROM lesson_progress lp
    JOIN lessons l  ON l.id = lp.lesson_id
    JOIN sections s ON s.id = l.section_id
    GROUP BY lp.user_id, s.course_id
  ) la ON la.user_id = e.user_id AND la.course_id = e.course_id`

const STATUS_SQL = `(CASE
    WHEN e.completed_at IS NOT NULL OR e.progress >= 100 THEN 'completed'
    WHEN e.progress > 0 OR la.last_activity IS NOT NULL THEN 'in_progress'
    ELSE 'not_started'
  END)`

const INACTIVE_SQL = `(${STATUS_SQL} = 'in_progress'
  AND COALESCE(la.last_activity, e.enrolled_at) < NOW() - INTERVAL ${INACTIVE_DAYS} DAY)`

// Deleted users are left out of reports and exports
const FROM_SQL = `
  FROM enrollments e
  JOIN users u   ON u.id = e.user_id AND u.deleted_at IS NULL
  JOIN courses c ON c.id = e.course_id
  ${LAST_ACTIVITY_JOIN}`

/**
 * WHERE clause for the admin filters. `skip` leaves filters out, e.g. the
 * status cards ignore the status filter so every card keeps its own count.
 */
const buildFilter = (f = {}, skip = []) => {
  const conditions = []
  const values = []
  const use = (key) => f[key] != null && f[key] !== '' && !skip.includes(key)

  if (use('course_id')) {
    conditions.push('e.course_id = ?')
    values.push(Number(f.course_id))
  }
  if (use('user_id')) {
    conditions.push('e.user_id = ?')
    values.push(Number(f.user_id))
  }
  if (use('search')) {
    const like = `%${String(f.search).trim()}%`
    conditions.push('(u.name LIKE ? OR u.email LIKE ? OR u.mobile LIKE ? OR c.title LIKE ?)')
    values.push(like, like, like, like)
  }
  if (use('country')) {
    if (f.country === 'unknown') {
      conditions.push('u.country IS NULL')
    } else {
      conditions.push('u.country = ?')
      values.push(String(f.country).toUpperCase())
    }
  }
  if (use('source')) {
    conditions.push('e.source = ?')
    values.push(f.source)
  }
  if (use('from')) {
    conditions.push('e.enrolled_at >= ?')
    values.push(f.from)
  }
  if (use('to')) {
    conditions.push('e.enrolled_at < DATE_ADD(?, INTERVAL 1 DAY)')
    values.push(f.to)
  }
  if (use('status')) {
    if (f.status === 'inactive') {
      conditions.push(INACTIVE_SQL)
    } else {
      conditions.push(`${STATUS_SQL} = ?`)
      values.push(f.status)
    }
  }

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values }
}

// limit = null → every matching row (CSV export)
const getAllEnrollments = ({ limit, offset = 0, ...filters }) => {
  const { where, values } = buildFilter(filters)
  const paging = limit == null ? '' : 'LIMIT ? OFFSET ?'
  if (limit != null) values.push(Number(limit), Number(offset))

  return pool.query(
    `SELECT
       e.id, e.user_id, e.course_id, e.payment_id, e.source,
       e.enrolled_at, e.completed_at, e.progress,
       u.name AS student_name, u.email AS student_email, u.mobile AS student_mobile,
       u.country AS student_country,
       c.title AS course_title, c.slug AS course_slug,
       la.last_activity,
       ${STATUS_SQL} AS status,
       ${INACTIVE_SQL} AS is_inactive
     ${FROM_SQL}
     ${where}
     ORDER BY e.enrolled_at DESC
     ${paging}`,
    values
  )
}

// ── Admin — count enrollments (for pagination) ────────────────────────────
const countEnrollments = (filters) => {
  const { where, values } = buildFilter(filters)
  return pool.query(`SELECT COUNT(*) AS total ${FROM_SQL} ${where}`, values)
}

const STATUS_COUNTS = `
  SUM(${STATUS_SQL} = 'completed') AS completed,
  SUM(${STATUS_SQL} = 'in_progress') AS in_progress,
  SUM(${STATUS_SQL} = 'not_started') AS not_started,
  SUM(${INACTIVE_SQL}) AS inactive`

// ── Admin — totals by status, by country and by course ────────────────────
const getEnrollmentStats = async (filters) => {
  const t = buildFilter(filters, ['status'])
  const [[totals]] = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(DISTINCT e.user_id) AS students,
       ${STATUS_COUNTS},
       SUM(e.enrolled_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')) AS this_month,
       SUM(la.last_activity >= NOW() - INTERVAL 7 DAY) AS active_7d,
       ROUND(AVG(e.progress)) AS avg_progress
     ${FROM_SQL} ${t.where}`,
    t.values
  )

  // Breakdowns ignore their own filter, so the chart still shows every bar
  const bc = buildFilter(filters, ['status', 'country'])
  const [byCountry] = await pool.query(
    `SELECT COALESCE(u.country, 'unknown') AS country,
       COUNT(*) AS enrollments, COUNT(DISTINCT e.user_id) AS students,
       ${STATUS_COUNTS}
     ${FROM_SQL} ${bc.where}
     GROUP BY COALESCE(u.country, 'unknown')
     ORDER BY enrollments DESC`,
    bc.values
  )

  const bk = buildFilter(filters, ['status', 'course_id'])
  const [byCourse] = await pool.query(
    `SELECT c.id AS course_id, c.title AS course_title,
       COUNT(*) AS enrollments, COUNT(DISTINCT e.user_id) AS students,
       ${STATUS_COUNTS}
     ${FROM_SQL} ${bk.where}
     GROUP BY c.id, c.title
     ORDER BY enrollments DESC`,
    bk.values
  )

  return { totals, by_country: byCountry, by_course: byCourse, inactive_days: INACTIVE_DAYS }
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
  getEnrollmentStats,
  createAssignedEnrollment,
  getUserEnrollmentsDetailed,
  deleteEnrollmentById,
  getAssignableCourses,
}
