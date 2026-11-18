// src/modules/integrations/meta.adapter.js
// Meta (Facebook / Instagram) lead forms (PRD §8).
// Webhook "leadgen" → leadgen_id → Graph API GET /{leadgen_id} with the Page
// access token → mapped to a CERTEZY lead. Platform lead id, form, ad and
// campaign are kept as source metadata.

import { getCredentials } from './credentials.js'

/** Lead ids announced by a webhook body: [{ external_id, form_id, page_id, ad_id }]. */
export const parseWebhook = (body) => {
  const out = []
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'leadgen' || !change.value?.leadgen_id) continue
      const v = change.value
      out.push({
        external_id: String(v.leadgen_id),
        form_id: v.form_id ? String(v.form_id) : null,
        page_id: v.page_id ? String(v.page_id) : String(entry.id ?? ''),
        ad_id: v.ad_id ? String(v.ad_id) : null,
      })
    }
  }
  return out
}

const FIELDS = 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,is_organic,custom_disclaimer_responses'

/**
 * Fetch the full lead from the Graph API with the token of the Page it came
 * from (several Pages can be connected). Throws on network / API errors
 * (retried by the queue).
 */
export const fetchLead = async (leadgenId, { pageId = null, fetchImpl = fetch } = {}) => {
  const { pages, pageAccessToken: primary, graphVersion } = await getCredentials('meta')
  const page = pageId ? pages.find((p) => String(p.id) === String(pageId)) : null
  if (pageId && !page && pages.some((p) => p.id)) {
    // A lead from a Page that isn't connected (any more): keep it for a retry after Reconnect
    throw Object.assign(new Error(`Page ${pageId} isn't connected — Reconnect Facebook and tick it, then Retry`), { permanent: true })
  }
  const pageAccessToken = page?.token ?? primary
  if (!pageAccessToken) throw new Error('The Meta Page access token is not set (Admin → Integrations)')
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(leadgenId)}?fields=${FIELDS}`
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${pageAccessToken}` } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Meta API ${res.status}: ${data?.error?.message ?? 'request failed'}`)
  return data
}

const first = (fields, ...names) => {
  for (const n of names) {
    const f = fields.find((x) => x.name?.toLowerCase() === n)
    if (f?.values?.[0]) return String(f.values[0]).trim()
  }
  return null
}

/** Graph lead → normalised lead. config.form_courses maps form id → course id. */
export const mapLead = (lead, config = {}) => {
  const fields = lead.field_data ?? []
  const name =
    first(fields, 'full_name', 'name') ??
    [first(fields, 'first_name'), first(fields, 'last_name')].filter(Boolean).join(' ') ??
    null
  const known = new Set(['full_name', 'name', 'first_name', 'last_name', 'email', 'phone_number', 'phone'])
  const answers = Object.fromEntries(
    fields.filter((f) => !known.has(f.name?.toLowerCase())).map((f) => [f.name, (f.values ?? []).join(', ')])
  )
  return {
    name: name || 'Meta lead',
    email: first(fields, 'email'),
    phone: first(fields, 'phone_number', 'phone'),
    course_id: config.form_courses?.[lead.form_id] ?? config.default_course_id ?? null,
    platform_lead_id: String(lead.id),
    source_meta: {
      campaign: lead.campaign_name ?? undefined,
      campaign_id: lead.campaign_id ?? undefined,
      ad: lead.ad_name ?? undefined,
      ad_id: lead.ad_id ?? undefined,
      adset: lead.adset_name ?? undefined,
      form: lead.form_id ?? undefined,
      platform: lead.platform ?? undefined,
      organic: lead.is_organic ?? undefined,
      answers: Object.keys(answers).length ? answers : undefined,
      submitted_at: lead.created_time ?? undefined,
    },
    consent: lead.custom_disclaimer_responses?.length
      ? { platform: 'meta', responses: lead.custom_disclaimer_responses }
      : { platform: 'meta', note: 'Submitted through a Meta lead form' },
  }
}

const FORM_STATUS = { ACTIVE: 'active', ARCHIVED: 'archived', DELETED: 'deleted', DRAFT: 'draft' }

/**
 * Every lead form on every connected Page, for picking in Admin → Integrations.
 * → { forms: [{ id, name, status, leads_count, created_at, owner_id, owner_name }], errors: [] }
 * (Needs pages_manage_ads / leads_retrieval; a Page that can't be read is reported, not fatal.)
 */
export const listForms = async ({ fetchImpl = fetch } = {}) => {
  const { pages, graphVersion } = await getCredentials('meta')
  const forms = []
  const errors = []
  for (const page of pages.filter((p) => p.token)) {
    let after = null
    try {
      for (let n = 0; n < 10; n++) {
        const q = new URLSearchParams({ fields: 'id,name,status,leads_count,created_time', limit: '100', ...(after && { after }) })
        const res = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(page.id ?? 'me')}/leadgen_forms?${q}`, {
          headers: { Authorization: `Bearer ${page.token}` },
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error?.message ?? `error ${res.status}`)
        for (const f of data.data ?? []) {
          forms.push({
            id: String(f.id),
            name: f.name ?? `Form ${f.id}`,
            status: FORM_STATUS[f.status] ?? (f.status ? String(f.status).toLowerCase() : null),
            leads_count: f.leads_count ?? null,
            created_at: f.created_time ?? null,
            owner_id: page.id ?? null,
            owner_name: page.name ?? null,
          })
        }
        after = data.paging?.next ? data.paging?.cursors?.after : null
        if (!after) break
      }
    } catch (err) {
      errors.push(`${page.name ?? 'Page'}: ${err.message}`)
    }
  }
  return { forms, errors }
}

/**
 * Leads submitted on one form after `sinceSec` (Unix seconds), all result
 * pages: GET /{form_id}/leads?filtering=[time_created > since]. Uses the
 * token of the Page that owns the form. Facebook keeps leads for 90 days.
 */
export const fetchFormLeads = async (form, sinceSec, { fetchImpl = fetch } = {}) => {
  const { pages, pageAccessToken, graphVersion } = await getCredentials('meta')
  const token = pages.find((p) => String(p.id) === String(form.owner_id))?.token ?? pageAccessToken
  if (!token) throw new Error('The Meta Page access token is not set (Admin → Integrations)')
  const filtering = JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(sinceSec) }])
  const out = []
  let after = null
  for (let n = 0; n < 20; n++) {
    const q = new URLSearchParams({ fields: FIELDS, filtering, limit: '100', ...(after && { after }) })
    const res = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(form.id)}/leads?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Meta API ${res.status}: ${data?.error?.message ?? 'request failed'}`)
    out.push(...(data.data ?? []))
    after = data.paging?.next ? data.paging?.cursors?.after : null
    if (!after) break
  }
  return out
}
