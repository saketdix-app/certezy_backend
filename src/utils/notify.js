// src/utils/notify.js
// In-app user_notifications (2.0): new lead assigned, leads waiting in the queue…
// Never throws — a failed notification must not undo the action behind it.

import { pool } from '../config/db.js'
import { sendPush } from './push.js'
import env from '../config/env.js'

// Also emailed (new leads matter even when nobody has the CRM open)
const EMAIL_TYPES = new Set(['lead_assigned'])

const emailAbout = async (ids, { title, body, link }) => {
  const [rows] = await pool.query(
    'SELECT id, name, email FROM users WHERE id IN (?) AND is_active = 1 AND deleted_at IS NULL',
    [ids]
  )
  if (!rows.length) return
  // Loaded only when needed (the queue opens a Redis connection)
  const { sendLeadAssignedJob } = await import('../jobs/emailQueue.js')
  for (const u of rows) {
    await sendLeadAssignedJob({ to: u.email, name: u.name, title, body, url: link ? `${env.frontendUrl}${link}` : `${env.frontendUrl}/login` })
  }
}

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
  // …and to their phones (CERTEZY Team app), without holding up the action
  sendPush(ids, { type, title, body, link }).catch(() => {})
  if (EMAIL_TYPES.has(type)) emailAbout(ids, { title, body, link }).catch((err) => console.error('Lead email failed:', err.message))
}

/** Active Admins and Super Admins (for "needs attention" alerts). */
export const managerIds = async () => {
  const [rows] = await pool.query(
    `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND is_active = 1 AND deleted_at IS NULL`
  )
  return rows.map((r) => r.id)
}
