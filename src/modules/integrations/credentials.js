// src/modules/integrations/credentials.js
// Integration API keys, managed from Admin → Integrations.
//   • Stored encrypted (AES-256-GCM, see utils/secretBox.js).
//   • Write-only: values never leave the server. The portal only sees whether
//     each key is set, where it comes from, and (for plain IDs) the last 4 characters.
//   • A key saved in the portal takes priority over the server .env; clearing
//     it in the portal falls back to .env.
//   • Only Super Admins can change them, after re-entering their password.
//     Every change is audit-logged (key names only) and other Super Admins are emailed.
//   • "Connect with Facebook / LinkedIn" (oauth.js) fills most keys
//     automatically; `internal` fields are only written by that flow.

import env from '../../config/env.js'
import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { keyFrom, open, seal } from '../../utils/secretBox.js'
import { linkedInFetch } from './linkedinVersion.js'
import { notifySuperAdmins, reauthenticate } from '../team/team.service.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

/**
 * Keys per integration. `secret: false` = an ID (last 4 shown); `env` = the
 * .env fallback; `optional` = not needed for leads to flow; `internal` = set
 * by Connect only, never listed or typed in.
 */
const none = () => ''
export const FIELDS = {
  meta: [
    { name: 'app_id', label: 'App ID', secret: false, optional: true, env: () => env.integrations.meta.appId },
    { name: 'page_access_token', label: 'Page access token', secret: true, env: () => env.integrations.meta.pageAccessToken },
    { name: 'app_secret', label: 'App secret', secret: true, env: () => env.integrations.meta.appSecret },
    { name: 'verify_token', label: 'Webhook verify token', secret: true, env: () => env.integrations.meta.verifyToken },
    { name: 'connection', internal: true, env: none },
  ],
  linkedin: [
    { name: 'client_id', label: 'Client ID', secret: false, optional: true, env: () => env.integrations.linkedin.clientId },
    { name: 'access_token', label: 'Access token', secret: true, env: () => env.integrations.linkedin.accessToken },
    { name: 'ad_account_id', label: 'Ad account ID', secret: false, env: () => env.integrations.linkedin.adAccountId },
    { name: 'client_secret', label: 'Client secret', secret: true, env: () => env.integrations.linkedin.clientSecret },
    { name: 'refresh_token', internal: true, secret: true, env: none },
    { name: 'connection', internal: true, env: none },
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
const resolve = async (source, { fresh = false } = {}) => {
  const hit = cache.get(source)
  if (!fresh && hit && hit.at > Date.now() - CACHE_MS) return hit.values
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

const parseConnection = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Credentials in the shape the adapters use. `fresh` skips the cache (webhook verification). */
export const getCredentials = async (source, opts = {}) => {
  const v = await resolve(source, opts)
  if (source === 'meta') {
    return {
      appId: v.app_id,
      pageAccessToken: v.page_access_token,
      appSecret: v.app_secret,
      verifyToken: v.verify_token,
      graphVersion: env.integrations.meta.graphVersion,
      connection: parseConnection(v.connection),
    }
  }
  if (source === 'linkedin') {
    return {
      clientId: v.client_id,
      accessToken: v.access_token,
      refreshToken: v.refresh_token,
      adAccountId: v.ad_account_id,
      clientSecret: v.client_secret,
      connection: parseConnection(v.connection),
    }
  }
  if (source === 'whatsapp') {
    const metaSecret = v.app_secret ? '' : (await resolve('meta', opts)).app_secret
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
  const all = FIELDS[source]
  if (!all) return { fields: [], configured: true, connection: null }
  const fields = all.filter((f) => !f.internal)
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
  const connRow = rows.find((r) => r.name === 'connection')
  const connection = connRow ? parseConnection(decrypt(connRow)) : null
  return { fields: out, configured: out.every((f) => f.set || f.optional), connection }
}

/**
 * Write keys (server-side callers: the portal save below and Connect).
 * '' removes a portal value. Replacing a token by hand forgets the old
 * Connect details, so the card doesn't describe a connection that's gone.
 */
export const setCredentialValues = async (source, values, actorId) => {
  const fields = FIELDS[source] ?? []
  const touched = Object.keys(values)
  if (!values.connection && touched.some((k) => ['page_access_token', 'access_token'].includes(k))) {
    values = { ...values, connection: '', ...(source === 'linkedin' && { refresh_token: '' }) }
  }
  const saved = []
  const cleared = []
  for (const f of fields) {
    if (typeof values[f.name] !== 'string') continue
    const value = values[f.name].trim()
    if (value) {
      await pool.query(
        `INSERT INTO integration_secrets (source, name, sealed, hint, updated_by) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE sealed = VALUES(sealed), hint = VALUES(hint), updated_by = VALUES(updated_by), updated_at = UTC_TIMESTAMP()`,
        [source, f.name, seal(value, key()), f.secret === false ? value.slice(-4) : null, actorId ?? null]
      )
      saved.push(f.label ?? f.name)
    } else {
      await pool.query('DELETE FROM integration_secrets WHERE source = ? AND name = ?', [source, f.name])
      cleared.push(f.label ?? f.name)
    }
  }
  clearCredentialCache()
  return { saved, cleared }
}

/**
 * Save keys from the portal. values: { field: string } — a non-empty string
 * replaces the key, '' removes the portal value (falls back to .env), a missing
 * field is left as is.
 */
export const saveCredentials = async (req, source, values, password) => {
  const actor = req.user
  const fields = FIELDS[source]?.filter((f) => !f.internal)
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

  const typed = Object.fromEntries(changes.map((f) => [f.name, values[f.name]]))
  const { saved: savedAll, cleared: clearedAll } = await setCredentialValues(source, typed, actor.id)
  const labels = new Set(fields.map((f) => f.label))
  const saved = savedAll.filter((l) => labels.has(l))
  const cleared = clearedAll.filter((l) => labels.has(l))
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
      const res = await linkedInFetch(
        `https://api.linkedin.com/rest/adAccounts/${encodeURIComponent(c.adAccountId)}`,
        { headers: { Authorization: `Bearer ${c.accessToken}` } },
        fetchImpl
      )
      const r = { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
      if (r.ok) return { ok: true, message: `Connected to the ad account "${r.data.name ?? c.adAccountId}"` }
      // 403 = the token works but the app can't read ad accounts (no Advertising API) — leads still import
      if (r.status === 403) return { ok: true, message: 'The LinkedIn token works (this app can\'t read ad account details, which lead import doesn\'t need)' }
      return { ok: false, message: `LinkedIn: ${apiError(r)}` }
    }
    return { ok: false, message: 'Nothing to test for this integration' }
  } catch (err) {
    return { ok: false, message: `Could not reach the platform: ${err.message}` }
  }
}
