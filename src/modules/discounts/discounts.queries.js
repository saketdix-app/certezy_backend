// src/modules/discounts/discounts.queries.js

import { pool } from '../../config/db.js'

// ── Create discount link ───────────────────────────────────────────────────
const createDiscountLink = ({
  token,
  user_id,
  email,
  course_id,
  original_price,
  discount_price,
  discount_price_inr,
  discount_pct,
  created_by,
  expires_at,
}) =>
  pool.query(
    `INSERT INTO discount_links
       (token, user_id, email, course_id, original_price, discount_price, discount_price_inr,
        discount_pct, created_by, expires_at, last_sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      token,
      user_id ?? null,
      email ?? null,
      course_id,
      original_price,
      discount_price,
      discount_price_inr ?? null,
      discount_pct ?? null,
      created_by,
      expires_at,
    ]
  )

// ── Get discount link by token ─────────────────────────────────────────────
const getDiscountByToken = (token) =>
  pool.query(`SELECT * FROM discount_links WHERE token = ? LIMIT 1`, [token])

// ── Get discount link by ID ────────────────────────────────────────────────
const getDiscountById = (id) => pool.query(`SELECT * FROM discount_links WHERE id = ? LIMIT 1`, [id])

// ── Public offer page: link + course ──────────────────────────────────────
const getOfferByToken = (token) =>
  pool.query(
    `SELECT d.token, d.email, d.user_id, d.original_price, d.discount_price, d.discount_price_inr, d.discount_pct,
            d.is_used, d.expires_at,
            c.id AS course_id, c.title AS course_title, c.slug AS course_slug,
            c.thumbnail AS course_thumbnail, c.short_desc AS course_short_desc
     FROM discount_links d
     JOIN courses c ON c.id = d.course_id
     WHERE d.token = ? LIMIT 1`,
    [token]
  )

// ── Mark discount link as used (binds an email-only link to the buyer) ────
const markDiscountUsed = (id, user_id = null) =>
  pool.query(
    `UPDATE discount_links
     SET is_used = 1, used_at = CURRENT_TIMESTAMP, user_id = COALESCE(user_id, ?)
     WHERE id = ?`,
    [user_id, id]
  )

// ── Admin — list / stats with filters ─────────────────────────────────────
// expires_at is stored in UTC (pool timezone 'Z')
const STATUS_SQL = `(CASE
    WHEN d.is_used = 1 THEN 'used'
    WHEN d.expires_at < UTC_TIMESTAMP() THEN 'expired'
    ELSE 'active'
  END)`

const buildFilter = (f = {}, skip = []) => {
  const conditions = []
  const values = []
  const use = (k) => f[k] != null && f[k] !== '' && !skip.includes(k)
  if (use('search')) {
    const like = `%${String(f.search).trim()}%`
    conditions.push('(u.name LIKE ? OR u.email LIKE ? OR d.email LIKE ? OR c.title LIKE ?)')
    values.push(like, like, like, like)
  }
  if (use('course_id')) {
    conditions.push('d.course_id = ?')
    values.push(Number(f.course_id))
  }
  if (use('status')) {
    conditions.push(`${STATUS_SQL} = ?`)
    values.push(f.status)
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values }
}

const FROM_SQL = `
  FROM discount_links d
  LEFT JOIN users u ON u.id = d.user_id
  JOIN courses c    ON c.id = d.course_id
  LEFT JOIN users a ON a.id = d.created_by`

const getAllDiscounts = ({ limit, offset, ...filters }) => {
  const { where, values } = buildFilter(filters)
  return pool.query(
    `SELECT
       d.id, d.token, d.course_id, d.original_price, d.discount_price, d.discount_price_inr,
       d.discount_pct, d.is_used, d.expires_at, d.used_at, d.created_at,
       d.sent_count, d.last_sent_at,
       COALESCE(u.name, 'Not registered yet') AS student_name,
       COALESCE(u.email, d.email) AS student_email,
       (d.user_id IS NULL) AS is_email_only,
       c.title AS course_title, c.slug AS course_slug,
       c.price_inr AS course_price_inr,
       a.name AS created_by_name,
       ${STATUS_SQL} AS status
     ${FROM_SQL}
     ${where}
     ORDER BY d.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, Number(limit), Number(offset)]
  )
}

const countDiscounts = (filters = {}) => {
  const { where, values } = buildFilter(filters)
  return pool.query(`SELECT COUNT(*) AS total ${FROM_SQL} ${where}`, values)
}

// Counts per status (status filter ignored so every card keeps its number)
const getDiscountStats = (filters = {}) => {
  const { where, values } = buildFilter(filters, ['status'])
  return pool.query(
    `SELECT COUNT(*) AS total,
       SUM(${STATUS_SQL} = 'active') AS active,
       SUM(${STATUS_SQL} = 'used') AS used,
       SUM(${STATUS_SQL} = 'expired') AS expired
     ${FROM_SQL} ${where}`,
    values
  )
}

// ── Resend: count it, and optionally give the link a new expiry ───────────
const markResent = (id, expires_at = null) =>
  pool.query(
    `UPDATE discount_links
     SET sent_count = sent_count + 1, last_sent_at = UTC_TIMESTAMP(),
         expires_at = COALESCE(?, expires_at)
     WHERE id = ?`,
    [expires_at, id]
  )

export {
  createDiscountLink,
  getDiscountByToken,
  getDiscountById,
  getOfferByToken,
  markDiscountUsed,
  getAllDiscounts,
  countDiscounts,
  getDiscountStats,
  markResent,
}
