// src/utils/push.js
// Phone push notifications for the CERTEZY Team app (Expo push service → FCM).
// Called from notify(): every in-app notification also goes to the person's
// signed-in phones. Never throws; tokens the service reports as gone are removed.

import { pool } from '../config/db.js'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const CHUNK = 100

/** "/consultant/leads?lead=42" → 42 (the app opens that lead when tapped). */
export const leadIdFromLink = (link) => {
  const m = /[?&]lead=(\d+)/.exec(String(link ?? ''))
  return m ? Number(m[1]) : null
}

export const sendPush = async (userIds, { type, title, body = null, link = null }) => {
  const ids = [...new Set([].concat(userIds).filter(Boolean))]
  if (!ids.length) return 0
  try {
    const [rows] = await pool.query(
      `SELECT t.token FROM user_push_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.user_id IN (${ids.map(() => '?').join(', ')}) AND u.is_active = 1 AND u.deleted_at IS NULL`,
      ids
    )
    if (!rows.length) return 0
    const messages = rows.map(({ token }) => ({
      to: token,
      title: title.slice(0, 200),
      ...(body && { body: body.slice(0, 500) }),
      sound: 'default',
      priority: 'high',
      channelId: 'leads',
      data: { type, link, lead_id: leadIdFromLink(link) },
    }))
    let sent = 0
    for (let i = 0; i < messages.length; i += CHUNK) {
      const batch = messages.slice(i, i + CHUNK)
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10000),
      })
      const json = await res.json().catch(() => ({}))
      const tickets = Array.isArray(json?.data) ? json.data : []
      const gone = []
      tickets.forEach((t, j) => {
        if (t?.status === 'ok') sent++
        else if (t?.details?.error === 'DeviceNotRegistered') gone.push(batch[j].to)
      })
      if (gone.length) {
        await pool.query(`DELETE FROM user_push_tokens WHERE token IN (${gone.map(() => '?').join(', ')})`, gone)
      }
    }
    return sent
  } catch (err) {
    console.error(`Push failed (${type}):`, err.message)
    return 0
  }
}

/** The app registers its Expo push token after sign-in (one phone = one token). */
export const registerDevice = async (userId, { token, platform, device_name: deviceName }) => {
  await pool.query(
    `INSERT INTO user_push_tokens (user_id, token, platform, device_name) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform),
       device_name = VALUES(device_name), last_seen_at = UTC_TIMESTAMP()`,
    [userId, token, platform ?? 'android', deviceName?.slice(0, 120) ?? null]
  )
}

/** Sign-out on the phone: stop pushes to it. */
export const removeDevice = async (userId, token) => {
  await pool.query('DELETE FROM user_push_tokens WHERE user_id = ? AND token = ?', [userId, token])
}
