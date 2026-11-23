// src/modules/crm/appRelease.service.js
// Latest CERTEZY Team app (APK) for "Check for updates" in the app. An Admin
// saves the version and download link after building a new APK.

import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { isAdmin } from '../../utils/access.js'

const KEYS = { version: 'app_latest_version', version_code: 'app_latest_version_code', apk_url: 'app_apk_url', notes: 'app_release_notes' }

export const getRelease = async () => {
  const [rows] = await pool.query('SELECT setting, value, updated_at FROM crm_settings WHERE setting IN (?)', [Object.values(KEYS)])
  const v = Object.fromEntries(rows.map((r) => [r.setting, r]))
  if (!v[KEYS.version]) return null
  return {
    version: v[KEYS.version].value,
    version_code: Number(v[KEYS.version_code]?.value ?? 0),
    apk_url: v[KEYS.apk_url]?.value ?? null,
    notes: v[KEYS.notes]?.value || null,
    published_at: v[KEYS.version].updated_at,
  }
}

export const saveRelease = async (req, body) => {
  if (!isAdmin(req.user)) throw Object.assign(new Error('Only Admins publish app updates'), { statusCode: 403 })
  for (const [k, setting] of Object.entries(KEYS)) {
    await pool.query(
      `INSERT INTO crm_settings (setting, value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
      [setting, String(body[k] ?? ''), req.user.id]
    )
  }
  await audit(req, { action: 'app.release', details: { version: body.version, version_code: body.version_code } })
  return getRelease()
}
