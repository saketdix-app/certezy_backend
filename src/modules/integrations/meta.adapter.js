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

/** Fetch the full lead from the Graph API. Throws on network / API errors (retried by the queue). */
export const fetchLead = async (leadgenId, { fetchImpl = fetch } = {}) => {
  const { pageAccessToken, graphVersion } = await getCredentials('meta')
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
