// src/modules/payments/payments.queries.js

import { pool } from '../../config/db.js'

// ── Create payment (pending) ───────────────────────────────────────────────
const createPayment = ({ user_id, course_id, amount, original_amount, currency, method, discount_link_id }) =>
  pool.query(
    `INSERT INTO payments
       (user_id, course_id, amount, original_amount, currency, method, discount_link_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      user_id,
      course_id,
      amount,
      original_amount ?? amount,
      currency ?? 'USD',
      method,
      discount_link_id ?? null,
    ]
  )

// ── Get payment by ID ──────────────────────────────────────────────────────
const getPaymentById = (id) => pool.query(`SELECT * FROM payments WHERE id = ? LIMIT 1`, [id])

// ── Gateway order id (Razorpay order / PayPal order) the payment was created with ──
const setGatewayOrderId = (id, gatewayOrderId) =>
  pool.query('UPDATE payments SET gateway_order_id = ? WHERE id = ?', [gatewayOrderId, id])

// ── Get payment by gateway_txn_id (idempotency check) ─────────────────────
const getPaymentByTxnId = (gateway_txn_id) =>
  pool.query(`SELECT * FROM payments WHERE gateway_txn_id = ? LIMIT 1`, [gateway_txn_id])

// ── Update payment to success ──────────────────────────────────────────────
const markPaymentSuccess = (id, { gateway_txn_id, invoice_url }) =>
  pool.query(
    `UPDATE payments
     SET status = 'success', gateway_txn_id = ?, invoice_url = ?
     WHERE id = ?`,
    [gateway_txn_id, invoice_url ?? null, id]
  )

// ── Update payment to failed ───────────────────────────────────────────────
const markPaymentFailed = (id) => pool.query(`UPDATE payments SET status = 'failed' WHERE id = ?`, [id])

// ── Get payment history of a student ──────────────────────────────────────
const getPaymentsByUserId = (user_id) =>
  pool.query(
    `SELECT
       p.id, p.amount, p.original_amount, p.currency,
       p.method, p.gateway_txn_id, p.status,
       p.invoice_url, p.created_at,
       c.title AS course_title, c.slug AS course_slug
     FROM payments p
     LEFT JOIN courses c ON c.id = p.course_id
     WHERE p.user_id = ?
     ORDER BY p.created_at DESC`,
    [user_id]
  )

// ── Admin — get all payments ───────────────────────────────────────────────
const getAllPayments = ({ limit, offset, status }) => {
  const conditions = []
  const values = []

  if (status) {
    conditions.push('p.status = ?')
    values.push(status)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  values.push(Number(limit), Number(offset))

  return pool.query(
    `SELECT
       p.id, p.user_id, p.course_id, p.amount, p.currency,
       p.method, p.gateway_txn_id, p.status, p.created_at,
       u.name AS student_name, u.email AS student_email,
       c.title AS course_title
     FROM payments p
     JOIN users u   ON u.id = p.user_id
     LEFT JOIN courses c ON c.id = p.course_id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    values
  )
}

// ── Count payments (pagination) ────────────────────────────────────────────
const countPayments = ({ status }) => {
  const conditions = []
  const values = []

  if (status) {
    conditions.push('p.status = ?')
    values.push(status)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  return pool.query(`SELECT COUNT(*) AS total FROM payments p ${where}`, values)
}

export {
  createPayment,
  getPaymentById,
  getPaymentByTxnId,
  markPaymentSuccess,
  markPaymentFailed,
  getPaymentsByUserId,
  getAllPayments,
  countPayments,
  setGatewayOrderId,
}
