// src/modules/integrations/ingest.service.js
// 2.0 Phase 7 — automated lead intake (PRD §8): Meta, LinkedIn, website.
//
// Pipeline: record event (idempotent: one row per source + platform lead id)
// → fetch & map → same validation / duplicate rules as manual leads → create
// → Round Robin (same distribution rules) → integration health updated.
//   • Webhook retries never create a second lead (unique source + external id).
//   • A person who's already a lead is NOT created again: the enquiry goes on
//     the existing lead's timeline and its owner (or the Admins) is notified.
//   • Failures are kept with the error and retried by the queue; Admins can
//     retry them from Admin → Integrations.

import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { managerIds, notify } from '../../utils/notify.js'
import { autoAssign } from '../crm/distribution.service.js'
import { findDuplicates, findStudentId, normalizeEmail, normalizePhone } from '../crm/leads.service.js'
import * as meta from './meta.adapter.js'
import * as linkedin from './linkedin.adapter.js'
import { getCredentials } from './credentials.js'

export const SOURCES = ['meta', 'linkedin', 'website', 'whatsapp']
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null)
const clip = (s, n = 500) => String(s ?? '').slice(0, n)

// ── Integration settings & health ─────────────────────────────────────────

export const getIntegration = async (source) => {
  const [[row]] = await pool.query('SELECT * FROM integrations WHERE source = ?', [source])
  return row ? { ...row, enabled: Boolean(row.enabled), config: parseJson(row.config) ?? {} } : { source, enabled: false, config: {} }
}

const markHealth = (source, ok, error) =>
  pool.query(
    ok
      ? 'UPDATE integrations SET last_event_at = UTC_TIMESTAMP(), last_success_at = UTC_TIMESTAMP() WHERE source = ?'
      : 'UPDATE integrations SET last_event_at = UTC_TIMESTAMP(), last_error_at = UTC_TIMESTAMP(), last_error = ? WHERE source = ?',
    ok ? [source] : [clip(error), source]
  )

// ── Events ────────────────────────────────────────────────────────────────

/**
 * Record an incoming lead notification. Returns { id, isNew }. The unique key
 * makes webhook retries harmless (PRD §6.5 idempotency keys).
 */
export const recordEvent = async (source, externalId, payload) => {
  const [r] = await pool.query(
    'INSERT IGNORE INTO lead_ingest_events (source, external_id, payload) VALUES (?, ?, ?)',
    [source, clip(externalId, 150), JSON.stringify(payload ?? null)]
  )
  if (r.affectedRows) return { id: r.insertId, isNew: true }
  const [[existing]] = await pool.query('SELECT id FROM lead_ingest_events WHERE source = ? AND external_id = ?', [source, externalId])
  return { id: existing?.id ?? null, isNew: false }
}

const finishEvent = (id, status, { leadId = null, error = null } = {}) =>
  pool.query(
    'UPDATE lead_ingest_events SET status = ?, lead_id = COALESCE(?, lead_id), error = ?, processed_at = UTC_TIMESTAMP() WHERE id = ?',
    [status, leadId, error ? clip(error) : null, id]
  )

// ── Lead creation (system) ────────────────────────────────────────────────

/**
 * Create a lead from a mapped integration record, or attach the enquiry to an
 * existing one. Returns { status: 'created' | 'duplicate', lead_id }.
 */
export const ingestLead = async (source, lead) => {
  if (!lead.phone && !lead.email) throw Object.assign(new Error('The lead has no phone number or email'), { permanent: true })

  const duplicates = await findDuplicates({ phone: lead.phone, email: lead.email, source, platform_lead_id: lead.platform_lead_id })
  if (duplicates.length) {
    const existing = duplicates[0]
    await pool.query('INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, NULL, ?, ?, ?)', [
      existing.id,
      'repeat_enquiry',
      null,
      JSON.stringify({ source, platform_lead_id: lead.platform_lead_id, campaign: lead.source_meta?.campaign, course_id: lead.course_id }),
    ])
    await notify(existing.owner_id ? [existing.owner_id] : await managerIds(), {
      type: 'repeat_enquiry',
      title: `${existing.name} enquired again`,
      body: `New ${source} enquiry from an existing lead`,
      link: existing.owner_id ? `/consultant/leads?lead=${existing.id}` : `/admin/leads?lead=${existing.id}`,
    })
    return { status: 'duplicate', lead_id: existing.id }
  }

  const sourceMeta = Object.fromEntries(Object.entries(lead.source_meta ?? {}).filter(([, v]) => v !== undefined && v !== ''))
  const [r] = await pool.query(
    `INSERT INTO leads (name, phone, phone_norm, email, email_norm, course_id, source, source_meta, platform_lead_id,
       consent, stage, stage_changed_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(), ?)`,
    [
      clip(lead.name, 150),
      lead.phone ? clip(lead.phone, 30) : null,
      normalizePhone(lead.phone),
      lead.email ? clip(lead.email, 150) : null,
      normalizeEmail(lead.email),
      lead.course_id || null,
      source,
      Object.keys(sourceMeta).length ? JSON.stringify(sourceMeta) : null,
      lead.platform_lead_id || null,
      lead.consent ? JSON.stringify(lead.consent) : null,
      await findStudentId(lead.email),
    ]
  )
  const id = r.insertId
  await pool.query("INSERT INTO lead_activities (lead_id, actor_id, type, meta) VALUES (?, NULL, 'created', ?)", [
    id,
    JSON.stringify({ source, campaign: sourceMeta.campaign }),
  ])
  await audit(null, { action: 'lead.create', targetType: 'lead', targetId: id, details: { source, automated: true } })
  // Same distribution rules as every other lead (PRD §8)
  await autoAssign(id)
  return { status: 'created', lead_id: id }
}

// ── Processing (called by the queue worker) ──────────────────────────────

const fetchAndMap = async (source, payload, config) => {
  if (source === 'meta') {
    const lead = meta.mapLead(await meta.fetchLead(payload.external_id, { pageId: payload.page_id }), config)
    if (payload.page_id) {
      const { pages } = await getCredentials('meta')
      lead.source_meta.page_id = String(payload.page_id)
      lead.source_meta.page = pages.find((p) => String(p.id) === String(payload.page_id))?.name ?? undefined
    }
    return lead
  }
  if (source === 'linkedin') {
    const questions = await linkedin.formQuestions(payload.response?.versionedLeadGenFormUrn ?? payload.response?.leadGenFormUrn)
    const lead = linkedin.mapResponse(payload.response, questions, config)
    if (payload.account_id) lead.source_meta.ad_account = String(payload.account_id)
    // Campaign name instead of "urn:li:sponsoredCampaign:…" (never blocks the import)
    const campaignId = linkedin.campaignIdOf(lead.source_meta?.campaign)
    if (campaignId) {
      lead.source_meta.campaign_id = campaignId
      lead.source_meta.campaign = (await linkedin.campaignName(campaignId, { accountId: payload.account_id })) ?? `LinkedIn campaign ${campaignId}`
    }
    return lead
  }
  if (source === 'website' || source === 'whatsapp') return payload.lead
  throw new Error(`Unknown source ${source}`)
}

/**
 * Process one recorded event. Throws on temporary failures so the queue
 * retries; permanent problems (no contact details) are stored as failed.
 */
/** The form an event came from, known before fetching the lead itself. */
const formOf = (source, payload) => {
  if (source === 'meta') return payload.form_id ? String(payload.form_id) : null
  if (source === 'linkedin') return linkedin.leadFormId(payload.response?.versionedLeadGenFormUrn ?? payload.response?.leadGenFormUrn)
  return null
}

export const processEvent = async (eventId) => {
  const [[event]] = await pool.query('SELECT * FROM lead_ingest_events WHERE id = ?', [eventId])
  if (!event || ['created', 'duplicate'].includes(event.status)) return event?.status ?? 'missing'
  const integration = await getIntegration(event.source)
  const payload = parseJson(event.payload) ?? {}
  // Only the forms chosen in Admin → Integrations (none chosen = every form).
  // Checked before the lead's details are fetched.
  const chosen = integration.config?.selected_forms
  const formId = formOf(event.source, payload)
  if (Array.isArray(chosen) && formId && !chosen.map(String).includes(formId)) {
    await finishEvent(event.id, 'skipped', { error: 'Form not selected in Admin → Integrations' })
    return 'skipped'
  }
  await pool.query("UPDATE lead_ingest_events SET attempts = attempts + 1, status = 'processing' WHERE id = ?", [event.id])
  try {
    const mapped = await fetchAndMap(event.source, payload, integration.config)
    // The form's name as well as its number
    const formName = integration.config?.form_names?.[mapped.source_meta?.form]
    if (formName) mapped.source_meta.form_name = formName
    const result = await ingestLead(event.source, mapped)
    await finishEvent(event.id, result.status, { leadId: result.lead_id })
    await markHealth(event.source, true)
    return result.status
  } catch (err) {
    await finishEvent(event.id, 'failed', { error: err.message })
    await markHealth(event.source, false, err.message)
    if (err.permanent) return 'failed'
    throw err
  }
}

// ── Website forms ─────────────────────────────────────────────────────────

/** A contact-form enquiry becomes a lead (source "website"). Never throws. */
export const ingestWebsiteEnquiry = async ({ contactId, name, email, phone, subject, message }) => {
  try {
    const integration = await getIntegration('website')
    if (!integration.enabled) return null
    const lead = {
      name,
      email,
      phone,
      course_id: null,
      platform_lead_id: `contact-${contactId}`,
      source_meta: { form: 'contact', campaign: undefined, answers: { subject, message: clip(message, 300) } },
      consent: { platform: 'website', note: 'Submitted the contact form' },
    }
    const { id, isNew } = await recordEvent('website', `contact-${contactId}`, { lead })
    if (!isNew) return null
    return await processEvent(id)
  } catch (err) {
    console.error('Website enquiry → lead failed:', err.message)
    return null
  }
}

// ── LinkedIn sync (polling) ───────────────────────────────────────────────

/**
 * Leads imported before names could be looked up show the raw campaign code
 * (or "LinkedIn campaign N"). Fill in the real names; safe to run often
 * (lookups are cached, failures retried after a few hours).
 */
export const fillLinkedInCampaignNames = async ({ limit = 500 } = {}) => {
  const [rows] = await pool.query(
    `SELECT id, JSON_UNQUOTE(JSON_EXTRACT(source_meta, '$.campaign')) AS campaign FROM leads
     WHERE source = 'linkedin'
       AND (JSON_UNQUOTE(JSON_EXTRACT(source_meta, '$.campaign')) LIKE 'urn:li:sponsoredCampaign:%'
         OR JSON_UNQUOTE(JSON_EXTRACT(source_meta, '$.campaign')) LIKE 'LinkedIn campaign %')
     ORDER BY id DESC LIMIT ?`,
    [limit]
  )
  let updated = 0
  for (const r of rows) {
    const id = linkedin.campaignIdOf(r.campaign)
    if (!id) continue
    const name = await linkedin.campaignName(id)
    // No name yet: at least make the code readable; tried again on a later run
    const label = name ?? `LinkedIn campaign ${id}`
    if (label === r.campaign) continue
    await pool.query("UPDATE leads SET source_meta = JSON_SET(source_meta, '$.campaign', ?, '$.campaign_id', ?) WHERE id = ?", [label, id, r.id])
    updated++
  }
  return updated
}

/** Per-account cursors: {"512345678": 1731700000000}. An older single number applies to every account. */
const readCursors = (raw, accounts) => {
  try {
    const v = JSON.parse(raw ?? 'null')
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
    if (Number(v)) return Object.fromEntries(accounts.map((a) => [a, Number(v)]))
  } catch {
    /* empty or broken: start fresh */
  }
  return {}
}

export const syncLinkedIn = async (enqueue) => {
  const integration = await getIntegration('linkedin')
  if (!integration.enabled) return { skipped: 'disabled' }
  const { adAccountIds } = await getCredentials('linkedin')
  if (!adAccountIds.length) {
    await markHealth('linkedin', false, 'No LinkedIn ad account set (Admin → Integrations)')
    return { error: 'No LinkedIn ad account set' }
  }
  const cursors = readCursors(integration.sync_cursor, adAccountIds)
  let fetched = 0
  let queued = 0
  const errors = []
  // One account failing doesn't stop the others
  for (const accountId of adAccountIds) {
    try {
      const since = Number(cursors[accountId]) || Date.now() - 7 * 86400e3
      const responses = await linkedin.fetchResponses(since, { accountId })
      let latest = since
      for (const r of responses) {
        if (!r?.id) continue
        latest = Math.max(latest, Number(r.submittedAt) || 0)
        const { id, isNew } = await recordEvent('linkedin', String(r.id), { response: r, account_id: accountId })
        if (isNew) {
          await enqueue(id)
          queued++
        }
      }
      fetched += responses.length
      cursors[accountId] = latest
    } catch (err) {
      errors.push(adAccountIds.length > 1 ? `Ad account ${accountId}: ${err.message}` : err.message)
    }
  }
  // Forget cursors of accounts that were removed
  const kept = Object.fromEntries(adAccountIds.filter((a) => cursors[a]).map((a) => [a, cursors[a]]))
  await pool.query('UPDATE integrations SET sync_cursor = ? WHERE source = ?', [JSON.stringify(kept), 'linkedin'])
  if (errors.length) {
    await markHealth('linkedin', false, errors.join(' · '))
    if (errors.length === adAccountIds.length) return { error: errors.join(' · ') }
  } else {
    await markHealth('linkedin', true)
  }
  await fillLinkedInCampaignNames().catch((err) => console.error('LinkedIn campaign names failed:', err.message))
  return { fetched, queued, accounts: adAccountIds.length, ...(errors.length && { partial_errors: errors }) }
}
