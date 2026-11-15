// src/utils/notify.js
// In-app user_notifications (2.0): new lead assigned, leads waiting in the queue…
// Never throws — a failed notification must not undo the action behind it.

import { pool } from '../config/db.js'

export const notify = async (userIds, { type, title, body = null, link = null }) => {
  const ids = [...new Set([].concat(userIds).filter(Boolean))]
  if (!ids.length) return
  try {
    await pool.query(
      `INSERT INTO user_notifications (user_id, type, title, body, link) VALUES ${ids.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      ids.flatMap((id) => [id, type, title.slice(0, 200), body?.slice(0, 500) ?? null, link])
    )
  } catch (err) {
    console.error(`Notification failed (${type}):`, err.message)
  }
}

/** Active Admins and Super Admins (for "needs attention" alerts). */
export const managerIds = async () => {
  const [rows] = await pool.query(
    `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND is_active = 1 AND deleted_at IS NULL`
  )
  return rows.map((r) => r.id)
}
