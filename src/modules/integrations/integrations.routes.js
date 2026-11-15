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
import { getIntegration, recordEvent, SOURCES, syncLinkedIn } from './ingest.service.js'
import * as meta from './meta.adapter.js'
import { linkedInChallengeResponse, verifyLinkedInSignature, verifyMetaSignature } from './signature.js'

export const webhooks = Router()
export const admin = Router()

const rawText = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.from(''))

// ── Meta ──────────────────────────────────────────────────────────────────

// Subscription check from the Meta app dashboard
webhooks.get('/meta', (req, res) => {
  const token = env.integrations.meta.verifyToken
  if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''))
  }
  return res.sendStatus(403)
})

webhooks.post('/meta', async (req, res) => {
  const raw = rawText(req)
  if (!verifyMetaSignature(raw, req.get('x-hub-signature-256'), env.integrations.meta.appSecret)) {
    await pool.query("UPDATE integrations SET last_error_at = UTC_TIMESTAMP(), last_error = 'Webhook with an invalid signature was rejected' WHERE source = 'meta'").catch(() => {})
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
webhooks.get('/linkedin', (req, res) => {
  const code = req.query.challengeCode
  const secret = env.integrations.linkedin.clientSecret
  if (!code || !secret) return res.sendStatus(400)
  return res.json({ challengeCode: code, challengeResponse: linkedInChallengeResponse(code, secret) })
})

// A notification only triggers an earlier sync; the sync fetches the responses
webhooks.post('/linkedin', async (req, res) => {
  if (!verifyLinkedInSignature(rawText(req), req.get('x-li-signature'), env.integrations.linkedin.clientSecret)) {
    return res.sendStatus(401)
  }
  res.sendStatus(200)
  syncLinkedIn(enqueueIngest).catch(() => {})
})

// ── Admin ─────────────────────────────────────────────────────────────────

const managers = [authenticate, role('admin')]
const READY = {
  meta: () => ({
    app_secret: Boolean(env.integrations.meta.appSecret),
    verify_token: Boolean(env.integrations.meta.verifyToken),
    page_access_token: Boolean(env.integrations.meta.pageAccessToken),
  }),
  linkedin: () => ({
    client_secret: Boolean(env.integrations.linkedin.clientSecret),
    access_token: Boolean(env.integrations.linkedin.accessToken),
    ad_account_id: Boolean(env.integrations.linkedin.adAccountId),
  }),
  website: () => ({ contact_form: true }),
}

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
      const ready = READY[source]()
      integrations.push({
        ...i,
        ready,
        configured: Object.values(ready).every(Boolean),
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

admin.post('/linkedin/sync', ...managers, async (req, res, next) => {
  try {
    const r = await syncLinkedIn(enqueueIngest)
    if (r.error) return res.status(502).json({ success: false, message: `LinkedIn: ${r.error}` })
    if (r.skipped) return res.status(400).json({ success: false, message: 'Turn the LinkedIn integration on first' })
    return success(res, { message: `${r.fetched} checked, ${r.queued} new`, data: r })
  } catch (err) {
    next(err)
  }
})
