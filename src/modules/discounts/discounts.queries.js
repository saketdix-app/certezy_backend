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
  discount_pct,
  created_by,
  expires_at,
}) =>
  pool.query(
    `INSERT INTO discount_links
       (token, user_id, email, course_id, original_price, discount_price, discount_pct, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      token,
      user_id ?? null,
      email ?? null,
      course_id,
      original_price,
      discount_price,
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
    `SELECT d.token, d.email, d.user_id, d.original_price, d.discount_price, d.discount_pct,
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

// ── Admin — get all discount links ─────────────────────────────────────────
const getAllDiscounts = ({ limit, offset }) =>
  pool.query(
    `SELECT
       d.id, d.token, d.original_price, d.discount_price,
       d.discount_pct, d.is_used, d.expires_at, d.used_at, d.created_at,
       COALESCE(u.name, 'Not registered yet') AS student_name,
       COALESCE(u.email, d.email) AS student_email,
       (d.user_id IS NULL) AS is_email_only,
       c.title AS course_title,  c.slug  AS course_slug,
       a.name  AS created_by_name
     FROM discount_links d
     LEFT JOIN users u ON u.id = d.user_id
     JOIN courses c ON c.id = d.course_id
     JOIN users a   ON a.id = d.created_by
     ORDER BY d.created_at DESC
     LIMIT ? OFFSET ?`,
    [Number(limit), Number(offset)]
  )

// ── Count discount links ───────────────────────────────────────────────────
const countDiscounts = () => pool.query(`SELECT COUNT(*) AS total FROM discount_links`)

export {
  createDiscountLink,
  getDiscountByToken,
  getDiscountById,
  getOfferByToken,
  markDiscountUsed,
  getAllDiscounts,
  countDiscounts,
}
