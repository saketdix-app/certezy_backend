// src/modules/integrations/linkedin.adapter.js
// LinkedIn Lead Gen Forms (PRD §8) through the Lead Sync API (requires
// LinkedIn to grant the app "Lead Sync" access). Sync pulls form responses
// submitted since the last cursor; webhooks (if enabled for the app) only
// trigger an earlier sync. Field names come from the form's predefined
// questions (FIRST_NAME, LAST_NAME, EMAIL, PHONE_NUMBER, …).
// NOTE: response shapes follow LinkedIn's Marketing API docs (versioned);
// confirm against a real account when connecting.

import { getCredentials } from './credentials.js'
import { linkedInFetch } from './linkedinVersion.js'

const API = 'https://api.linkedin.com/rest'

const get = async (path, fetchImpl) => {
  const { accessToken } = await getCredentials('linkedin')
  const res = await linkedInFetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } }, fetchImpl)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${data?.message ?? 'request failed'}`)
  return data
}

/** Form responses submitted after `sinceMs`. */
export const fetchResponses = async (sinceMs, { accountId = null, fetchImpl = fetch } = {}) => {
  const creds = await getCredentials('linkedin')
  const { accessToken } = creds
  const adAccountId = accountId ?? creds.adAccountId
  if (!accessToken || !adAccountId) throw new Error('The LinkedIn access token / ad account ID are not set (Admin → Integrations)')
  if (!/^\d+$/.test(adAccountId)) {
    throw new Error('The LinkedIn Ad account ID isn\'t a number — enter just the number from Campaign Manager (e.g. 512345678) under Change keys')
  }
  const owner = encodeURIComponent(`urn:li:sponsoredAccount:${adAccountId}`)
  const start = Math.max(0, Number(sinceMs) || Date.now() - 7 * 86400e3)
  const end = Date.now()
  const out = []
  // Page through (LinkedIn returns at most `count` per request)
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await get(
      `/leadFormResponses?q=owner&owner=(sponsoredAccount:${owner})&leadType=(leadType:SPONSORED)` +
        `&submittedAtTimeRange=(start:${start},end:${end})&start=${page * PAGE}&count=${PAGE}`,
      fetchImpl
    )
    const elements = data.elements ?? []
    out.push(...elements)
    if (elements.length < PAGE) break
  }
  // Only what was asked for, even if LinkedIn ignored the time filter
  return out.filter((r) => !r?.submittedAt || Number(r.submittedAt) >= start)
}

const PAGE = 100
const MAX_PAGES = 20

/**
 * Form id from what a response carries:
 *   "urn:li:leadGenForm:3162" or "urn:li:versionedLeadGenForm:(urn:li:leadGenForm:3162,1)" → "3162"
 */
export const leadFormId = (urn) => {
  const s = String(urn ?? '')
  const m = s.match(/leadGenForm:(\d+)/) ?? s.match(/(\d+)/)
  return m ? m[1] : null
}

const localized = (v) => (v?.localized ? Object.values(v.localized)[0] : typeof v === 'string' ? v : null)

const formCache = new Map()
/**
 * questionId → { field, label, options } for one form.
 *   field: LinkedIn's predefined field (FIRST_NAME, EMAIL, …) or null for custom questions
 *   label: the question as shown on the form
 *   options: multiple-choice option id → text
 */
export const formQuestions = async (formUrn, { fetchImpl = fetch } = {}) => {
  const id = leadFormId(formUrn)
  if (!id) return {}
  if (formCache.has(id)) return formCache.get(id)
  const form = await get(`/leadForms/${id}`, fetchImpl)
  const map = Object.fromEntries(
    (form?.content?.questions ?? []).map((q) => [
      q.questionId,
      {
        field: q.predefinedField ?? null,
        label: localized(q.question) ?? q.name ?? `Question ${q.questionId}`,
        options: Object.fromEntries(
          (q.questionDetails?.multipleChoiceQuestionDetails?.options ?? []).map((o) => [o.id, localized(o.text) ?? String(o.id)])
        ),
      },
    ])
  )
  formCache.set(id, map)
  return map
}

const answerText = (a, q) => {
  const d = a?.answerDetails ?? {}
  if (d.textQuestionAnswer) return d.textQuestionAnswer.answer ?? null
  if (d.multipleChoiceAnswer) return (d.multipleChoiceAnswer.options ?? []).map((o) => q?.options?.[o] ?? String(o)).join(', ') || null
  return null
}

/** LinkedIn response + question map → normalised lead. config.form_courses maps form id → course id. */
export const mapResponse = (r, questions = {}, config = {}) => {
  const values = {} // predefined fields: FIRST_NAME, EMAIL, …
  const answers = {} // custom questions, by their label
  for (const a of r?.formResponse?.answers ?? []) {
    const q = questions[a.questionId]
    const text = answerText(a, q)
    if (!text) continue
    if (q?.field) values[q.field] = text
    else answers[q?.label ?? `Question ${a.questionId}`] = text
  }
  const name = [values.FIRST_NAME, values.LAST_NAME].filter(Boolean).join(' ').trim()
  const formId = leadFormId(r?.versionedLeadGenFormUrn ?? r?.leadGenFormUrn)
  const known = new Set(['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE_NUMBER', 'WORK_EMAIL', 'WORK_PHONE_NUMBER'])
  for (const [k, v] of Object.entries(values)) if (!known.has(k)) answers[k] = v // company, job title, country, …
  return {
    name: name || 'LinkedIn lead',
    email: values.EMAIL ?? values.WORK_EMAIL ?? null,
    phone: values.PHONE_NUMBER ?? values.WORK_PHONE_NUMBER ?? null,
    course_id: config.form_courses?.[formId] ?? config.default_course_id ?? null,
    platform_lead_id: String(r?.id ?? ''),
    source_meta: {
      campaign: r?.leadMetadata?.sponsoredLeadMetadata?.campaign ?? undefined,
      form: formId ?? undefined,
      test_lead: r?.testLead ? true : undefined,
      answers: Object.keys(answers).length ? answers : undefined,
      submitted_at: r?.submittedAt ? new Date(Number(r.submittedAt)).toISOString() : undefined,
    },
    consent: { platform: 'linkedin', consents: r?.formResponse?.consentResponses ?? undefined },
    submitted_at_ms: Number(r?.submittedAt) || null,
  }
}

// ── Campaign names ────────────────────────────────────────────────────────
// Responses only carry "urn:li:sponsoredCampaign:229559253". The name comes
// from GET /adAccounts/{account}/adCampaigns/{id}, which needs the app's
// Advertising API access (r_ads). Names are cached; a failed lookup is not
// retried for 6 hours.

const campaignNames = new Map()
const campaignMisses = new Map()
const MISS_RETRY_MS = 6 * 60 * 60 * 1000

/** "urn:li:sponsoredCampaign:229559253" or "LinkedIn campaign 229559253" → "229559253"; a name → null. */
export const campaignIdOf = (value) => String(value ?? '').match(/^(?:urn:li:sponsoredCampaign:|LinkedIn campaign )(\d+)$/)?.[1] ?? null

/** The campaign's name from LinkedIn, or null if it can't be read right now. */
export const campaignName = async (campaignId, { accountId = null, fetchImpl = fetch } = {}) => {
  if (!campaignId) return null
  if (campaignNames.has(campaignId)) return campaignNames.get(campaignId)
  if (Date.now() - (campaignMisses.get(campaignId) ?? 0) < MISS_RETRY_MS) return null
  // The campaign's own account first; otherwise try each connected account
  const { adAccountIds } = await getCredentials('linkedin')
  const accounts = [...new Set([accountId, ...adAccountIds].filter((a) => /^\d+$/.test(a ?? '')))]
  for (const acct of accounts) {
    try {
      const d = await get(`/adAccounts/${acct}/adCampaigns/${campaignId}`, fetchImpl)
      const name = typeof d?.name === 'string' && d.name.trim() ? d.name.trim() : null
      if (name) {
        campaignNames.set(campaignId, name)
        return name
      }
    } catch {
      /* not in this account, or no access — try the next */
    }
  }
  campaignMisses.set(campaignId, Date.now())
  return null
}

/** For tests. */
export const clearCampaignCache = () => {
  campaignNames.clear()
  campaignMisses.clear()
}

const LI_FORM_STATUS = { PUBLISHED: 'active', ARCHIVED: 'archived', DRAFT: 'draft' }

/**
 * Every lead form in every connected ad account (GET /leadForms?q=owner).
 * → { forms: [{ id, name, status, owner_id, owner_name }], errors: [] }
 */
export const listForms = async ({ fetchImpl = fetch } = {}) => {
  const { adAccountIds, connection } = await getCredentials('linkedin')
  const accountName = Object.fromEntries((connection?.accounts ?? []).map((a) => [a.id, a.name]))
  const forms = []
  const errors = []
  for (const acct of adAccountIds.filter((a) => /^\d+$/.test(a))) {
    const owner = encodeURIComponent(`urn:li:sponsoredAccount:${acct}`)
    try {
      for (let page = 0; page < 10; page++) {
        const data = await get(`/leadForms?q=owner&owner=(sponsoredAccount:${owner})&start=${page * PAGE}&count=${PAGE}`, fetchImpl)
        const elements = data.elements ?? []
        for (const f of elements) {
          forms.push({
            id: String(f.id),
            name: f.name ?? `Form ${f.id}`,
            status: LI_FORM_STATUS[f.state] ?? (f.state ? String(f.state).toLowerCase() : null),
            leads_count: null,
            created_at: f.created ? new Date(Number(f.created)).toISOString() : null,
            owner_id: acct,
            owner_name: accountName[acct] ?? `Ad account ${acct}`,
          })
        }
        if (elements.length < PAGE) break
      }
    } catch (err) {
      errors.push(`${accountName[acct] ?? `Ad account ${acct}`}: ${err.message}`)
    }
  }
  return { forms, errors }
}
