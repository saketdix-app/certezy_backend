// src/modules/courses/courses.queries.js

import { pool } from '../../config/db.js'

// ── Allowed sort fields — SQL injection se bachao ──────────────────────────
const ALLOWED_SORT = ['price', 'created_at', 'rating_avg', 'rating_count', 'enrolled_count', 'title']
const ALLOWED_ORDER = ['ASC', 'DESC']

// ── Shared WHERE builder for list + count ─────────────────────────────────
const buildFilters = ({ status, category_id, level, is_featured, search, pricing }) => {
  const conditions = []
  const values = []

  if (status) {
    conditions.push('c.status = ?')
    values.push(status)
  } else {
    conditions.push("c.status = 'published'")
  }
  if (category_id) {
    conditions.push('c.category_id = ?')
    values.push(category_id)
  }
  if (level) {
    conditions.push('c.level = ?')
    values.push(level)
  }
  if (is_featured !== undefined && is_featured !== '') {
    conditions.push('c.is_featured = ?')
    values.push(is_featured === 'true' || is_featured === '1' || is_featured === true ? 1 : 0)
  }
  if (pricing === 'free') {
    conditions.push("(c.pricing_type = 'free' OR c.price <= 0)")
  } else if (pricing === 'paid') {
    conditions.push("(c.pricing_type = 'paid' AND c.price > 0)")
  } else if (pricing === 'discounted') {
    conditions.push("(c.pricing_type = 'paid' AND c.original_price > c.price)")
  }
  if (search) {
    // Full-text for words, LIKE fallback so short terms ("AZ", "PMP") still match
    conditions.push(
      '(MATCH(c.title, c.description, c.short_desc) AGAINST(? IN BOOLEAN MODE) OR c.title LIKE ?)'
    )
    values.push(`${search}*`, `%${search}%`)
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, values }
}

const LIST_COLUMNS = `
  c.id, c.title, c.slug, c.short_desc, c.thumbnail,
  c.price, c.original_price, c.pricing_type,
  c.level, c.language, c.status, c.is_featured,
  c.total_duration, c.total_lessons, c.enrolled_count,
  c.rating_avg, c.rating_count, c.certificate_eligible,
  c.created_at,
  cat.id AS category_id, cat.name AS category_name, cat.slug AS category_slug,
  u.id AS instructor_id, u.name AS instructor_name`

// ── Get courses (filters + pagination + sorting) ───────────────────────────
const getAllCourses = ({ limit, offset, sortBy = 'created_at', sortOrder = 'DESC', ...filters }) => {
  const { where, values } = buildFilters(filters)

  // Whitelisted sort — never interpolate user input directly
  const finalSort = ALLOWED_SORT.includes(sortBy) ? `c.${sortBy}` : 'c.created_at'
  const finalOrder = ALLOWED_ORDER.includes(sortOrder?.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC'

  return pool.query(
    `SELECT ${LIST_COLUMNS}
     FROM courses c
     LEFT JOIN categories cat ON cat.id = c.category_id
     LEFT JOIN users u ON u.id = c.created_by
     ${where}
     ORDER BY ${finalSort} ${finalOrder}, c.id DESC
     LIMIT ? OFFSET ?`,
    [...values, Number(limit), Number(offset)]
  )
}

// ── Count courses (for pagination) ─────────────────────────────────────────
const countCourses = (filters) => {
  const { where, values } = buildFilters(filters)
  return pool.query(`SELECT COUNT(*) AS total FROM courses c ${where}`, values)
}

// ── Get single course by slug (full detail) ────────────────────────────────
const getCourseBySlug = (slug) =>
  pool.query(
    `SELECT
       c.*,
       cat.id AS category_id, cat.name AS category_name, cat.slug AS category_slug,
       u.id AS instructor_id, u.name AS instructor_name
     FROM courses c
     LEFT JOIN categories cat ON cat.id = c.category_id
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.slug = ?
     LIMIT 1`,
    [slug]
  )

// ── Get single course by ID ────────────────────────────────────────────────
const getCourseById = (id) =>
  pool.query(
    `SELECT
       c.*,
       cat.id AS category_id, cat.name AS category_name, cat.slug AS category_slug,
       u.id AS instructor_id, u.name AS instructor_name
     FROM courses c
     LEFT JOIN categories cat ON cat.id = c.category_id
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.id = ?
     LIMIT 1`,
    [id]
  )

// ── Check slug exists (create & update) ───────────────────────────────────
const checkSlugExists = (slug, excludeId = null) => {
  if (excludeId) {
    return pool.query('SELECT id FROM courses WHERE slug = ? AND id != ? LIMIT 1', [slug, excludeId])
  }
  return pool.query('SELECT id FROM courses WHERE slug = ? LIMIT 1', [slug])
}

// ── Check category exists and is active ───────────────────────────────────
const checkCategoryExists = (category_id) =>
  pool.query('SELECT id FROM categories WHERE id = ? AND is_active = 1 LIMIT 1', [category_id])

// ── Check if course exists and not archived ────────────────────────────────
const checkCourseExists = (course_id) =>
  pool.query("SELECT id FROM courses WHERE id = ? AND status != 'archived' LIMIT 1", [course_id])

// ── Create course ──────────────────────────────────────────────────────────
const createCourse = ({
  title,
  slug,
  description,
  short_desc,
  category_id,
  thumbnail,
  preview_video,
  price,
  original_price,
  pricing_type,
  level,
  language,
  status,
  is_featured,
  requirements,
  what_you_learn,
  certificate_eligible,
  created_by,
}) =>
  pool.query(
    `INSERT INTO courses
       (title, slug, description, short_desc, category_id,
        thumbnail, preview_video, price, original_price, pricing_type, level, language,
        status, is_featured, requirements, what_you_learn,
        certificate_eligible, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title,
      slug,
      description ?? null,
      short_desc ?? null,
      category_id,
      thumbnail ?? null,
      preview_video ?? null,
      price ?? 0.0,
      original_price ?? null,
      pricing_type ?? 'paid',
      level ?? 'beginner',
      language ?? 'English',
      status ?? 'draft',
      is_featured ?? 0,
      requirements ?? null,
      what_you_learn ?? null,
      certificate_eligible ?? 1,
      created_by,
    ]
  )

// ── Update course ──────────────────────────────────────────────────────────
const updateCourse = (
  id,
  {
    title,
    slug,
    description,
    short_desc,
    category_id,
    thumbnail,
    preview_video,
    price,
    original_price,
    pricing_type,
    level,
    language,
    status,
    is_featured,
    requirements,
    what_you_learn,
    certificate_eligible,
  }
) =>
  pool.query(
    `UPDATE courses
     SET title = ?, slug = ?, description = ?, short_desc = ?,
         category_id = ?, thumbnail = ?, preview_video = ?,
         price = ?, original_price = ?, pricing_type = ?, level = ?, language = ?, status = ?,
         is_featured = ?, requirements = ?, what_you_learn = ?,
         certificate_eligible = ?
     WHERE id = ?`,
    [
      title,
      slug,
      description,
      short_desc,
      category_id,
      thumbnail,
      preview_video,
      price,
      original_price,
      pricing_type,
      level,
      language,
      status,
      is_featured,
      requirements,
      what_you_learn,
      certificate_eligible,
      id,
    ]
  )

// ── Delete course ──────────────────────────────────────────────────────────
const deleteCourseById = (id) => pool.query("UPDATE courses SET status = 'archived' WHERE id = ?", [id])

// ── Check if course has enrollments ───────────────────────────────────────
const hasEnrollments = (id) => pool.query('SELECT id FROM enrollments WHERE course_id = ? LIMIT 1', [id])

// ── Increment enrolled count ───────────────────────────────────────────────
const incrementEnrolledCount = (id) =>
  pool.query('UPDATE courses SET enrolled_count = enrolled_count + 1 WHERE id = ?', [id])

const decrementEnrolledCount = (id) =>
  pool.query('UPDATE courses SET enrolled_count = GREATEST(enrolled_count - 1, 0) WHERE id = ?', [id])

// ── Update rating (called after review submit) ────────────────────────────
const updateRating = (id, { rating_avg, rating_count }) =>
  pool.query('UPDATE courses SET rating_avg = ?, rating_count = ? WHERE id = ?', [
    rating_avg,
    rating_count,
    id,
  ])

// ── Update total lessons & duration (called after lesson add/delete) ──────
const updateCourseMeta = (id, { total_lessons, total_duration }) =>
  pool.query('UPDATE courses SET total_lessons = ?, total_duration = ? WHERE id = ?', [
    total_lessons,
    total_duration,
    id,
  ])

export {
  getAllCourses,
  countCourses,
  getCourseBySlug,
  getCourseById,
  checkSlugExists,
  checkCategoryExists,
  checkCourseExists,
  createCourse,
  updateCourse,
  deleteCourseById,
  hasEnrollments,
  incrementEnrolledCount,
  decrementEnrolledCount,
  updateRating,
  updateCourseMeta,
}
