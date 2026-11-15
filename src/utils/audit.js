// src/utils/audit.js
// Append-only audit trail for sensitive actions (PRD §9.2). Rows are only ever
// inserted — there is no update or delete path in the API.

import { pool } from '../config/db.js'

/**
 * Record an action. Never throws: a failed audit write is logged, and the
 * action itself has already happened (or been refused) either way.
 * @param {object} req      Express request (actor, IP, user agent); may be null
 * @param {object} event    { action, targetType, targetId, result, details }
 */
export const audit = async (req, { action, targetType = null, targetId = null, result = 'success', details }) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, result, details, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req?.user?.id ?? null,
        req?.user?.role ?? null,
        action,
        targetType,
        targetId,
        result,
        details ? JSON.stringify(details) : null,
        req?.ip ?? null,
        String(req?.headers?.['user-agent'] ?? '').slice(0, 255) || null,
      ]
    )
  } catch (err) {
    console.error(`Audit log write failed (${action}):`, err.message)
  }
}

export const listAuditLogs = async ({ action, actorId, targetType, targetId, page = 1, limit = 50 }) => {
  const where = []
  const values = []
  const add = (sql, value) => {
    where.push(sql)
    values.push(value)
  }
  if (action) add('a.action = ?', action)
  if (actorId) add('a.actor_id = ?', actorId)
  if (targetType) add('a.target_type = ?', targetType)
  if (targetId) add('a.target_id = ?', targetId)
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const offset = (page - 1) * limit

  const [rows] = await pool.query(
    `SELECT a.*, u.name AS actor_name, u.email AS actor_email, t.name AS target_name, t.email AS target_email
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_id
     LEFT JOIN users t ON a.target_type = 'user' AND t.id = a.target_id
     ${clause}
     ORDER BY a.id DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  )
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs a ${clause}`, values)
  return {
    logs: rows.map((r) => ({
      ...r,
      details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
    })),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  }
}
