// src/modules/discounts/discounts.queries.js

import { pool } from '../../config/db.js'

// ── Create discount link ───────────────────────────────────────────────────
const createDiscountLink = ({
  token,
  user_id,
  course_id,
  original_price,
  discount_price,
  discount_pct,
  created_by,
  expires_at,
}) =>
  pool.query(
    `INSERT INTO discount_links
       (token, user_id, course_id, original_price, discount_price, discount_pct, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [token, user_id, course_id, original_price, discount_price, discount_pct ?? null, created_by, expires_at]
  )

// ── Get discount link by token ─────────────────────────────────────────────
const getDiscountByToken = (token) =>
  pool.query(`SELECT * FROM discount_links WHERE token = ? LIMIT 1`, [token])

// ── Get discount link by ID ────────────────────────────────────────────────
const getDiscountById = (id) => pool.query(`SELECT * FROM discount_links WHERE id = ? LIMIT 1`, [id])

// ── Mark discount link as used ─────────────────────────────────────────────
const markDiscountUsed = (id) =>
  pool.query(
    `UPDATE discount_links
     SET is_used = 1, used_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [id]
  )

// ── Admin — get all discount links ─────────────────────────────────────────
const getAllDiscounts = ({ limit, offset }) =>
  pool.query(
    `SELECT
       d.id, d.token, d.original_price, d.discount_price,
       d.discount_pct, d.is_used, d.expires_at, d.used_at, d.created_at,
       u.name  AS student_name,  u.email AS student_email,
       c.title AS course_title,  c.slug  AS course_slug,
       a.name  AS created_by_name
     FROM discount_links d
     JOIN users u   ON u.id = d.user_id
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
  markDiscountUsed,
  getAllDiscounts,
  countDiscounts,
}
