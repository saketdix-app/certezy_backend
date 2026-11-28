// src/modules/integrations/integrations.routes.js
// 2.0 Phase 7 — lead integrations.
//   Public webhooks (signature-checked, raw body): /webhooks/meta, /webhooks/linkedin
//   Admin: /integrations (status, settings, events, retry, sync now)

import { Router } from 'express'
import env from '../../config/env.js'
import { pool } from '../../config/db.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'
import { success } from '../../utils/response.js'
import { audit } from '../../utils/audit.js'
import { enqueueIngest } from '../../jobs/leadIngestQueue.js'
import { getIntegration, recordEvent, SOURCES, syncLinkedIn, syncMeta } from './ingest.service.js'
import * as meta from './meta.adapter.js'
import * as whatsapp from './whatsapp.adapter.js'
import * as linkedinAdapter from './linkedin.adapter.js'
import { handleInbound, handleStatus } from './whatsapp.service.js'
import { credentialStatus, getCredentials, saveCredentials, testConnection } from './credentials.js'
import { chooseConnect, connectMetaSystemUser, finishConnect, integrationAlerts, OAUTH_SOURCES, redirectUri, startConnect } from './oauth.js'
import { linkedInChallengeResponse, verifyLinkedInSignature, verifyMetaSignature } from './signature.js'

export const webhooks = Router()
export const admin = Router()

const rawText = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.from(''))

// ── Meta ──────────────────────────────────────────────────────────────────

// Subscription check from the Meta app dashboard
webhooks.get('/meta', async (req, res) => {
  const token = (await getCredentials('meta', { fresh: true }).catch(() => ({}))).verifyToken
  if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''))
  }
  return res.sendStatus(403)
})

webhooks.post('/meta', async (req, res) => {
  const raw = rawText(req)
  const { appSecret } = await getCredentials('meta').catch(() => ({}))
  if (!verifyMetaSignature(raw, req.get('x-hub-signature-256'), appSecret)) {
    // Only worth flagging on the card once the integration is set up
    if (appSecret) await pool.query("UPDATE integrations SET last_error_at = UTC_TIMESTAMP(), last_error = 'Webhook with an invalid signature was rejected' WHERE source = 'meta'").catch(() => {})
    return res.sendStatus(401)
  }
  // Answer fast (Meta retries slow webhooks); the queue does the work
  res.sendStatus(200)
  try {
    const integration = await getIntegration('meta')
    for (const lead of meta.parseWebhook(JSON.parse(raw.toString('utf8') || '{}'))) {
      const { id, isNew } = await recordEvent('meta', lead.external_id, lead)
      if (!isNew) continue
      if (integration.enabled) await enqueueIngest(id)
      else await pool.query("UPDATE lead_ingest_events SET status = 'skipped', error = 'Meta integration is off' WHERE id = ?", [id])
    }
  } catch (err) {
    console.error('Meta webhook handling failed:', err.message)
  }
})

// ── LinkedIn ──────────────────────────────────────────────────────────────

// Webhook validation: respond with the HMAC of the challenge code
webhooks.get('/linkedin', async (req, res) => {
  const code = req.query.challengeCode
  const secret = (await getCredentials('linkedin', { fresh: true }).catch(() => ({}))).clientSecret
  if (!code || !secret) return res.sendStatus(400)
  return res.json({ challengeCode: code, challengeResponse: linkedInChallengeResponse(code, secret) })
})

// A notification only triggers an earlier sync; the sync fetches the responses
webhooks.post('/linkedin', async (req, res) => {
  const { clientSecret } = await getCredentials('linkedin').catch(() => ({}))
  if (!verifyLinkedInSignature(rawText(req), req.get('x-li-signature'), clientSecret)) {
    return res.sendStatus(401)
  }
  res.sendStatus(200)
  syncLinkedIn(enqueueIngest).catch(() => {})
})

// ── WhatsApp (Cloud API) ──────────────────────────────────────────────────

webhooks.get('/whatsapp', async (req, res) => {
  const token = (await getCredentials('whatsapp', { fresh: true }).catch(() => ({}))).verifyToken
  if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''))
  }
  return res.sendStatus(403)
})

webhooks.post('/whatsapp', async (req, res) => {
  const raw = rawText(req)
  const { appSecret } = await getCredentials('whatsapp').catch(() => ({}))
  if (!verifyMetaSignature(raw, req.get('x-hub-signature-256'), appSecret)) return res.sendStatus(401)
  res.sendStatus(200)
  try {
    const { messages, statuses } = whatsapp.parseWebhook(JSON.parse(raw.toString('utf8') || '{}'))
    for (const m of messages) await handleInbound(m)
    for (const s of statuses) await handleStatus(s)
  } catch (err) {
    console.error('WhatsApp webhook handling failed:', err.message)
  }
})

// ── Admin ─────────────────────────────────────────────────────────────────

const managers = [authenticate, role('admin')]
// For the admin header: connections expiring within 7 days or no longer working
admin.get('/alerts', ...managers, async (req, res, next) => {
  try {
    return success(res, { data: await integrationAlerts() })
  } catch (err) {
    next(err)
  }
})

// Every lead form on the connected Pages / ad accounts, to pick from
admin.get('/:source/forms', ...managers, async (req, res, next) => {
  try {
    const { source } = req.params
    const lister = { meta: meta.listForms, linkedin: linkedinAdapter.listForms }[source]
    if (!lister) return res.status(404).json({ success: false, message: 'This integration has no forms to list' })
    return success(res, { data: await lister() })
  } catch (err) {
    next(err)
  }
})

admin.get('/', ...managers, async (req, res, next) => {
  try {
    const base = `${env.frontendUrl}/api/v1/webhooks`
    const [counts] = await pool.query(
      `SELECT source, status, COUNT(*) AS n FROM lead_ingest_events
       WHERE received_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY GROUP BY source, status`
    )
    const [events] = await pool.query(
      `SELECT e.id, e.source, e.external_id, e.status, e.attempts, e.error, e.lead_id, e.received_at, e.processed_at,
              l.name AS lead_name
       FROM lead_ingest_events e LEFT JOIN leads l ON l.id = e.lead_id
       ORDER BY e.id DESC LIMIT 60`
    )
    const integrations = []
    for (const source of SOURCES) {
      const i = await getIntegration(source)
      const { fields, configured, connection } = await credentialStatus(source)
      integrations.push({
        ...i,
        credentials: fields, // set / from where — never the values
        configured,
        connection, // who / what is connected (no tokens)
        oauth: OAUTH_SOURCES.includes(source) ? { redirect_uri: redirectUri(source) } : null,
        webhook_url: source === 'website' ? null : `${base}/${source}`,
        last_7_days: Object.fromEntries(counts.filter((c) => c.source === source).map((c) => [c.status, Number(c.n)])),
      })
    }
    return success(res, { data: { integrations, events } })
  } catch (err) {
    next(err)
  }
})

admin.put('/:source', ...managers, validate(schemas.integrationSettings), async (req, res, next) => {
  try {
    const { source } = req.params
    if (!SOURCES.includes(source)) return res.status(404).json({ success: false, message: 'Unknown integration' })
    const current = await getIntegration(source)
    const config = req.body.config ?? current.config
    await pool.query(
      `INSERT INTO integrations (source, enabled, config, updated_by) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), config = VALUES(config), updated_by = VALUES(updated_by)`,
      [source, req.body.enabled ?? current.enabled ? 1 : 0, JSON.stringify(config ?? {}), req.user.id]
    )
    await audit(req, { action: 'integration.update', targetType: 'integration', details: { source, enabled: req.body.enabled, config } })
    return success(res, { message: 'Saved', data: await getIntegration(source) })
  } catch (err) {
    next(err)
  }
})

// Keys: Super Admin only + password (checked in saveCredentials)
admin.put('/:source/credentials', ...managers, validate(schemas.integrationCredentials), async (req, res, next) => {
  try {
    const credentials = await saveCredentials(req, req.params.source, req.body.values, req.body.password)
    return success(res, { message: 'Keys saved', data: { credentials: credentials.fields, configured: credentials.configured } })
  } catch (err) {
    next(err)
  }
})

// Connect with Facebook / LinkedIn (Super Admin; checks in oauth.js)
admin.post('/:source/connect', ...managers, validate(schemas.integrationConnect), async (req, res, next) => {
  try {
    return success(res, { data: await startConnect(req, req.params.source, req.body.password) })
  } catch (err) {
    next(err)
  }
})

admin.post('/:source/oauth', ...managers, validate(schemas.integrationOAuth), async (req, res, next) => {
  try {
    return success(res, { data: await finishConnect(req, req.params.source, req.body) })
  } catch (err) {
    next(err)
  }
})

admin.post('/:source/oauth/choose', ...managers, validate(schemas.integrationOAuthChoose), async (req, res, next) => {
  try {
    return success(res, { data: await chooseConnect(req, req.params.source, req.body) })
  } catch (err) {
    next(err)
  }
})

// Facebook: connect with a Meta Business System User token (no 90-day re-login)
admin.post('/meta/system-user', ...managers, validate(schemas.integrationSystemUser), async (req, res, next) => {
  try {
    return success(res, { data: await connectMetaSystemUser(req, req.body) })
  } catch (err) {
    next(err)
  }
})

admin.post('/:source/test', ...managers, async (req, res, next) => {
  try {
    if (!SOURCES.includes(req.params.source)) return res.status(404).json({ success: false, message: 'Unknown integration' })
    const result = await testConnection(req.params.source)
    await audit(req, { action: 'integration.test', targetType: 'integration', result: result.ok ? 'success' : 'failed', details: { source: req.params.source } })
    return success(res, { message: result.message, data: result })
  } catch (err) {
    next(err)
  }
})

admin.post('/events/:id/retry', ...managers, async (req, res, next) => {
  try {
    const [[e]] = await pool.query('SELECT id, status FROM lead_ingest_events WHERE id = ?', [req.params.id])
    if (!e) return res.status(404).json({ success: false, message: 'Event not found' })
    if (['created', 'duplicate'].includes(e.status)) {
      return res.status(409).json({ success: false, message: 'This one was already imported' })
    }
    await pool.query("UPDATE lead_ingest_events SET status = 'received', error = NULL WHERE id = ?", [e.id])
    await enqueueIngest(e.id)
    await audit(req, { action: 'integration.retry', targetType: 'ingest_event', targetId: e.id })
    return success(res, { message: 'Queued for another try' })
  } catch (err) {
    next(err)
  }
})

// Re-queue every failed import of one source (e.g. after a fix) — last 30 days, at most 1000
admin.post('/:source/retry-failed', ...managers, async (req, res, next) => {
  try {
    const { source } = req.params
    if (!SOURCES.includes(source)) return res.status(404).json({ success: false, message: 'Unknown integration' })
    const [rows] = await pool.query(
      `SELECT id FROM lead_ingest_events
       WHERE source = ? AND status = 'failed' AND received_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY
       ORDER BY id LIMIT 1000`,
      [source]
    )
    if (!rows.length) return success(res, { message: 'Nothing to retry', data: { queued: 0 } })
    const ids = rows.map((r) => r.id)
    await pool.query("UPDATE lead_ingest_events SET status = 'received', error = NULL WHERE id IN (?)", [ids])
    for (const id of ids) await enqueueIngest(id)
    await audit(req, { action: 'integration.retry_failed', targetType: 'integration', details: { source, count: ids.length } })
    return success(res, { message: `${ids.length} queued for another try`, data: { queued: ids.length } })
  } catch (err) {
    next(err)
  }
})

// Facebook: read leads from the forms now; { days } (1–90) also imports older ones
admin.post('/meta/sync', ...managers, async (req, res, next) => {
  try {
    const days = Number(req.body?.days) || null
    if (days !== null && (days < 1 || days > 90)) return res.status(400).json({ success: false, message: 'Choose between 1 and 90 days' })
    const r = await syncMeta(enqueueIngest, { days })
    if (r.skipped) return res.status(400).json({ success: false, message: 'Turn the Meta integration on first' })
    if (r.error) return res.status(502).json({ success: false, message: `Facebook: ${r.error}` })
    if (days) await audit(req, { action: 'integration.import_past', targetType: 'integration', details: { source: 'meta', days, queued: r.queued } })
    const problems = r.partial_errors?.length ? ` (${r.partial_errors.join(' · ')})` : ''
    return success(res, { message: `${r.fetched} found in ${r.forms} form${r.forms === 1 ? '' : 's'}, ${r.queued} new${problems}`, data: r })
  } catch (err) {
    next(err)
  }
})

admin.post('/linkedin/sync', ...managers, async (req, res, next) => {
  try {
    const r = await syncLinkedIn(enqueueIngest)
    if (r.error) return res.status(502).json({ success: false, message: `LinkedIn: ${r.error}` })
    if (r.skipped) return res.status(400).json({ success: false, message: 'Turn the LinkedIn integration on first' })
    const across = r.accounts > 1 ? ` across ${r.accounts} ad accounts` : ''
    const problems = r.partial_errors?.length ? ` (${r.partial_errors.join(' · ')})` : ''
    return success(res, { message: `${r.fetched} checked, ${r.queued} new${across}${problems}`, data: r })
  } catch (err) {
    next(err)
  }
})
