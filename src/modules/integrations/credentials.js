// src/modules/integrations/credentials.js
// Integration API keys, managed from Admin → Integrations.
//   • Stored encrypted (AES-256-GCM, see utils/secretBox.js).
//   • Write-only: values never leave the server. The portal only sees whether
//     each key is set, where it comes from, and (for plain IDs) the last 4 characters.
//   • A key saved in the portal takes priority over the server .env; clearing
//     it in the portal falls back to .env.
//   • Only Super Admins can change them, after re-entering their password.
//     Every change is audit-logged (key names only) and other Super Admins are emailed.

import env from '../../config/env.js'
import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { keyFrom, open, seal } from '../../utils/secretBox.js'
import { notifySuperAdmins, reauthenticate } from '../team/team.service.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

/** Keys per integration. `secret: false` = an ID (last 4 shown); `env` = the .env fallback. */
export const FIELDS = {
  meta: [
    { name: 'page_access_token', label: 'Page access token', secret: true, env: () => env.integrations.meta.pageAccessToken },
    { name: 'app_secret', label: 'App secret', secret: true, env: () => env.integrations.meta.appSecret },
    { name: 'verify_token', label: 'Webhook verify token', secret: true, env: () => env.integrations.meta.verifyToken },
  ],
  linkedin: [
    { name: 'access_token', label: 'Access token', secret: true, env: () => env.integrations.linkedin.accessToken },
    { name: 'ad_account_id', label: 'Ad account ID', secret: false, env: () => env.integrations.linkedin.adAccountId },
    { name: 'client_secret', label: 'Client secret', secret: true, env: () => env.integrations.linkedin.clientSecret },
  ],
  whatsapp: [
    { name: 'token', label: 'Access token', secret: true, env: () => env.integrations.whatsapp.token },
    { name: 'phone_number_id', label: 'Phone number ID', secret: false, env: () => env.integrations.whatsapp.phoneNumberId },
    { name: 'business_account_id', label: 'Business account ID', secret: false, optional: true, env: () => env.integrations.whatsapp.businessAccountId },
    { name: 'verify_token', label: 'Webhook verify token', secret: true, env: () => env.integrations.whatsapp.verifyToken },
    // Falls back to the Meta app secret (same Meta app), then to .env
    { name: 'app_secret', label: 'App secret', secret: true, env: () => env.integrations.whatsapp.appSecret },
  ],
}

const key = () => keyFrom(env.secretsEncryptionKey, env.jwt.secret)
const CACHE_MS = 60 * 1000 // the queue worker is a separate process: it picks up changes within a minute
const cache = new Map()

const storedRows = async (source) => {
  const [rows] = await pool.query(
    `SELECT s.name, s.sealed, s.hint, s.updated_at, u.name AS updated_by_name
     FROM integration_secrets s LEFT JOIN users u ON u.id = s.updated_by WHERE s.source = ?`,
    [source]
  )
  return rows
}

const decrypt = (row) => {
  try {
    return open(row.sealed, key())
  } catch {
    console.error(`Saved ${row.name} key could not be decrypted (was the encryption key changed?) — re-enter it in Admin → Integrations`)
    return null
  }
}

/** Plain values by field name for one source (portal value, else .env). Server-side use only. */
const resolve = async (source) => {
  const hit = cache.get(source)
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.values
  const rows = await storedRows(source)
  const values = {}
  for (const f of FIELDS[source] ?? []) {
    const row = rows.find((r) => r.name === f.name)
    values[f.name] = (row && decrypt(row)) || f.env() || ''
  }
  cache.set(source, { at: Date.now(), values })
  return values
}

export const clearCredentialCache = () => cache.clear()

/** Credentials in the shape the adapters use. */
export const getCredentials = async (source) => {
  const v = await resolve(source)
  if (source === 'meta') {
    return { pageAccessToken: v.page_access_token, appSecret: v.app_secret, verifyToken: v.verify_token, graphVersion: env.integrations.meta.graphVersion }
  }
  if (source === 'linkedin') {
    return { accessToken: v.access_token, adAccountId: v.ad_account_id, clientSecret: v.client_secret, version: env.integrations.linkedin.version }
  }
  if (source === 'whatsapp') {
    const metaSecret = v.app_secret ? '' : (await resolve('meta')).app_secret
    return {
      token: v.token,
      phoneNumberId: v.phone_number_id,
      businessAccountId: v.business_account_id,
      verifyToken: v.verify_token,
      appSecret: v.app_secret || metaSecret,
      graphVersion: env.integrations.meta.graphVersion,
    }
  }
  return {}
}

/** What the portal may see: per key, whether it is set and where from. Never the value. */
export const credentialStatus = async (source) => {
  const fields = FIELDS[source]
  if (!fields) return { fields: [], configured: true }
  const rows = await storedRows(source)
  const out = fields.map((f) => {
    const row = rows.find((r) => r.name === f.name)
    const readable = row ? decrypt(row) !== null : false
    const fromEnv = Boolean(f.env())
    return {
      name: f.name,
      label: f.label,
      secret: f.secret,
      optional: Boolean(f.optional),
      set: readable || fromEnv,
      from: readable ? 'admin' : fromEnv ? 'server' : null,
      hint: readable && !f.secret ? row.hint : null,
      unreadable: Boolean(row && !readable),
      updated_at: row?.updated_at ?? null,
      updated_by_name: row?.updated_by_name ?? null,
    }
  })
  if (source === 'whatsapp') {
    const appSecret = out.find((f) => f.name === 'app_secret')
    if (!appSecret.set && (await getCredentials('whatsapp')).appSecret) Object.assign(appSecret, { set: true, from: 'meta' })
  }
  return { fields: out, configured: out.every((f) => f.set || f.optional) }
}

/**
 * Save keys from the portal. values: { field: string } — a non-empty string
 * replaces the key, '' removes the portal value (falls back to .env), a missing
 * field is left as is.
 */
export const saveCredentials = async (req, source, values, password) => {
  const actor = req.user
  const fields = FIELDS[source]
  if (!fields) throw fail(404, 'This integration has no keys to save')
  if (actor.role !== 'super_admin') {
    await audit(req, { action: 'integration.credentials', result: 'denied', targetType: 'integration', details: { source } })
    throw fail(403, 'Only a Super Admin can change integration keys')
  }
  const changes = fields.filter((f) => typeof values?.[f.name] === 'string')
  if (!changes.length) throw fail(400, 'Nothing to save')
  for (const f of changes) {
    if (values[f.name].trim().length > 4000) throw fail(400, `${f.label} is too long`)
  }
  try {
    await reauthenticate(actor, password)
  } catch (err) {
    await audit(req, { action: 'integration.credentials', result: 'denied', targetType: 'integration', details: { source, reason: 'password' } })
    throw err
  }

  const saved = []
  const cleared = []
  for (const f of changes) {
    const value = values[f.name].trim()
    if (value) {
      await pool.query(
        `INSERT INTO integration_secrets (source, name, sealed, hint, updated_by) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE sealed = VALUES(sealed), hint = VALUES(hint), updated_by = VALUES(updated_by), updated_at = UTC_TIMESTAMP()`,
        [source, f.name, seal(value, key()), f.secret ? null : value.slice(-4), actor.id]
      )
      saved.push(f.label)
    } else {
      await pool.query('DELETE FROM integration_secrets WHERE source = ? AND name = ?', [source, f.name])
      cleared.push(f.label)
    }
  }
  clearCredentialCache()
  // Names only — never values
  await audit(req, { action: 'integration.credentials', targetType: 'integration', details: { source, saved, cleared } })
  await notifySuperAdmins(
    `${source[0].toUpperCase()}${source.slice(1)} integration keys were changed`,
    [
      saved.length ? `Updated: ${saved.join(', ')}` : null,
      cleared.length ? `Removed from the portal: ${cleared.join(', ')}` : null,
      `Changed by: ${actor.name}`,
    ].filter(Boolean),
    actor.id
  )
  return credentialStatus(source)
}

// ── Test connection ──────────────────────────────────────────────────────

const callJson = async (url, headers, fetchImpl) => {
  const res = await fetchImpl(url, { headers })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}
const apiError = (r) => r.data?.error?.message ?? r.data?.message ?? `error ${r.status}`

/** Check the saved keys against the platform. → { ok, message }. Never throws for API errors. */
export const testConnection = async (source, { fetchImpl = fetch } = {}) => {
  const c = await getCredentials(source)
  try {
    if (source === 'meta') {
      if (!c.pageAccessToken) return { ok: false, message: 'Add the Page access token first' }
      const r = await callJson(`https://graph.facebook.com/${c.graphVersion}/me?fields=id,name`, { Authorization: `Bearer ${c.pageAccessToken}` }, fetchImpl)
      return r.ok ? { ok: true, message: `Connected to the Facebook Page "${r.data.name}"` } : { ok: false, message: `Meta: ${apiError(r)}` }
    }
    if (source === 'whatsapp') {
      if (!c.token || !c.phoneNumberId) return { ok: false, message: 'Add the access token and phone number ID first' }
      const r = await callJson(
        `https://graph.facebook.com/${c.graphVersion}/${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name`,
        { Authorization: `Bearer ${c.token}` },
        fetchImpl
      )
      return r.ok
        ? { ok: true, message: `Connected to ${r.data.verified_name ?? 'WhatsApp'} (${r.data.display_phone_number ?? c.phoneNumberId})` }
        : { ok: false, message: `WhatsApp: ${apiError(r)}` }
    }
    if (source === 'linkedin') {
      if (!c.accessToken || !c.adAccountId) return { ok: false, message: 'Add the access token and ad account ID first' }
      const r = await callJson(
        `https://api.linkedin.com/rest/adAccounts/${encodeURIComponent(c.adAccountId)}`,
        { Authorization: `Bearer ${c.accessToken}`, 'LinkedIn-Version': c.version, 'X-Restli-Protocol-Version': '2.0.0' },
        fetchImpl
      )
      return r.ok ? { ok: true, message: `Connected to the ad account "${r.data.name ?? c.adAccountId}"` } : { ok: false, message: `LinkedIn: ${apiError(r)}` }
    }
    return { ok: false, message: 'Nothing to test for this integration' }
  } catch (err) {
    return { ok: false, message: `Could not reach the platform: ${err.message}` }
  }
}
