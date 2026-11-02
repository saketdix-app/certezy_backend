// src/modules/contact/contact.queries.js

import { pool } from '../../config/db.js'

// ── Create contact message ─────────────────────────────────────
const createContact = async ({ user_id, name, email, phone, subject, message }) => {
  const [result] = await pool.query(
    `INSERT INTO contacts (user_id, name, email, phone, subject, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
    [user_id || null, name, email, phone || null, subject, message]
  )
  return result.insertId
}

// ── Find by id ─────────────────────────────────────────────────
const findById = async (id) => {
  const [rows] = await pool.query(`SELECT * FROM contacts WHERE id = ? LIMIT 1`, [id])
  return rows[0] || null
}

// ── Get all contacts (admin) ───────────────────────────────────
const getAll = ({ limit, offset, status, search }) => {
  const conditions = []
  const values = []

  if (status) {
    conditions.push('status = ?')
    values.push(status)
  }
  if (search) {
    conditions.push('(name LIKE ? OR email LIKE ? OR subject LIKE ?)')
    values.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  values.push(Number(limit), Number(offset))

  return pool.query(
    `SELECT id, user_id, name, email, phone, subject,
                LEFT(message, 100) AS message_preview,
                status, created_at
         FROM contacts ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
    values
  )
}

// ── Count contacts (admin) ─────────────────────────────────────
const countAll = ({ status, search }) => {
  const conditions = []
  const values = []

  if (status) {
    conditions.push('status = ?')
    values.push(status)
  }
  if (search) {
    conditions.push('(name LIKE ? OR email LIKE ? OR subject LIKE ?)')
    values.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  return pool.query(`SELECT COUNT(*) AS total FROM contacts ${where}`, values)
}

// ── Update status (admin) ──────────────────────────────────────
const updateStatus = (id, status) => pool.query(`UPDATE contacts SET status = ? WHERE id = ?`, [status, id])

// ── Replies (admin) ────────────────────────────────────────────
const addReply = async ({ contact_id, admin_id, message }) => {
  const [result] = await pool.query(
    'INSERT INTO contact_replies (contact_id, admin_id, message) VALUES (?, ?, ?)',
    [contact_id, admin_id ?? null, message]
  )
  return result.insertId
}

const getReplies = (contact_id) =>
  pool.query(
    `SELECT r.id, r.message, r.created_at, u.name AS admin_name
     FROM contact_replies r
     LEFT JOIN users u ON u.id = r.admin_id
     WHERE r.contact_id = ?
     ORDER BY r.created_at ASC, r.id ASC`,
    [contact_id]
  )

export { createContact, findById, getAll, countAll, updateStatus, addReply, getReplies }
