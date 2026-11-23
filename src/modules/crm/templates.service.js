// src/modules/crm/templates.service.js
// Saved WhatsApp / email messages a consultant sends to leads. Placeholders are
// filled in by the app: {name}, {first_name}, {course}, {my_name}, {my_phone}.
// Each person keeps their own; Admins can also save team-wide ones.

import { pool } from '../../config/db.js'
import { isAdmin } from '../../utils/access.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const MAX_PER_PERSON = 40
const shape = (r, actor) => ({ ...r, shared: r.user_id == null, mine: r.user_id === actor.id, can_edit: r.user_id === actor.id || (r.user_id == null && isAdmin(actor)) })

export const listTemplates = async (actor) => {
  const [rows] = await pool.query(
    `SELECT id, user_id, channel, title, subject, body, updated_at FROM message_templates
     WHERE user_id = ? OR user_id IS NULL ORDER BY (user_id IS NULL), channel, title`,
    [actor.id]
  )
  return rows.map((r) => shape(r, actor))
}

const load = async (actor, id) => {
  const [[row]] = await pool.query('SELECT * FROM message_templates WHERE id = ? LIMIT 1', [id])
  if (!row || !(row.user_id === actor.id || (row.user_id == null && isAdmin(actor)))) throw fail(404, 'Template not found')
  return row
}

export const createTemplate = async (actor, { channel, title, subject, body, shared }) => {
  if (shared && !isAdmin(actor)) throw fail(403, 'Only Admins save templates for the whole team')
  const owner = shared ? null : actor.id
  if (owner) {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM message_templates WHERE user_id = ?', [owner])
    if (Number(n) >= MAX_PER_PERSON) throw fail(400, `You can keep up to ${MAX_PER_PERSON} templates — delete one first`)
  }
  const [r] = await pool.query(
    'INSERT INTO message_templates (user_id, channel, title, subject, body) VALUES (?, ?, ?, ?, ?)',
    [owner, channel, title.trim(), channel === 'email' ? subject?.trim() || null : null, body.trim()]
  )
  return shape({ id: r.insertId, user_id: owner, channel, title, subject, body }, actor)
}

export const updateTemplate = async (actor, id, { channel, title, subject, body }) => {
  const row = await load(actor, id)
  await pool.query('UPDATE message_templates SET channel = ?, title = ?, subject = ?, body = ? WHERE id = ?', [
    channel,
    title.trim(),
    channel === 'email' ? subject?.trim() || null : null,
    body.trim(),
    row.id,
  ])
  return shape({ ...row, channel, title, subject, body }, actor)
}

export const deleteTemplate = async (actor, id) => {
  const row = await load(actor, id)
  await pool.query('DELETE FROM message_templates WHERE id = ?', [row.id])
  return { id: row.id, deleted: true }
}
