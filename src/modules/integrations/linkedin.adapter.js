// src/modules/integrations/linkedin.adapter.js
// LinkedIn Lead Gen Forms (PRD §8) through the Lead Sync API (requires
// LinkedIn to grant the app "Lead Sync" access). Sync pulls form responses
// submitted since the last cursor; webhooks (if enabled for the app) only
// trigger an earlier sync. Field names come from the form's predefined
// questions (FIRST_NAME, LAST_NAME, EMAIL, PHONE_NUMBER, …).
// NOTE: response shapes follow LinkedIn's Marketing API docs (versioned);
// confirm against a real account when connecting.

import { getCredentials } from './credentials.js'

const API = 'https://api.linkedin.com/rest'

const headers = async () => {
  const { accessToken, version } = await getCredentials('linkedin')
  return { Authorization: `Bearer ${accessToken}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' }
}

const get = async (path, fetchImpl) => {
  const res = await fetchImpl(`${API}${path}`, { headers: await headers() })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${data?.message ?? 'request failed'}`)
  return data
}

/** Form responses submitted after `sinceMs`. */
export const fetchResponses = async (sinceMs, { fetchImpl = fetch } = {}) => {
  const { accessToken, adAccountId } = await getCredentials('linkedin')
  if (!accessToken || !adAccountId) throw new Error('The LinkedIn access token / ad account ID are not set (Admin → Integrations)')
  const owner = encodeURIComponent(`urn:li:sponsoredAccount:${adAccountId}`)
  const start = Math.max(0, Number(sinceMs) || Date.now() - 7 * 86400e3)
  const data = await get(
    `/leadFormResponses?q=owner&owner=(sponsoredAccount:${owner})&leadType=(leadType:SPONSORED)` +
      `&submittedAtTimeRange=(start:${start},end:${Date.now()})&count=100`,
    fetchImpl
  )
  return data.elements ?? []
}

const formCache = new Map()
/** questionId → predefined field name, for one form. */
export const formQuestions = async (formUrn, { fetchImpl = fetch } = {}) => {
  if (!formUrn) return {}
  if (formCache.has(formUrn)) return formCache.get(formUrn)
  const id = String(formUrn).split(':').pop()
  const form = await get(`/leadForms/${encodeURIComponent(id)}`, fetchImpl)
  const map = Object.fromEntries(
    (form?.content?.questions ?? []).map((q) => [q.questionId, q.predefinedField ?? q.name ?? `q${q.questionId}`])
  )
  formCache.set(formUrn, map)
  return map
}

const answerText = (a) =>
  a?.answerDetails?.textQuestionAnswer?.answer ??
  a?.answerDetails?.multipleChoiceAnswer?.options?.join(', ') ??
  null

/** LinkedIn response + question map → normalised lead. config.form_courses maps form id → course id. */
export const mapResponse = (r, questions = {}, config = {}) => {
  const values = {}
  for (const a of r?.formResponse?.answers ?? []) values[questions[a.questionId] ?? `q${a.questionId}`] = answerText(a)
  const name = [values.FIRST_NAME, values.LAST_NAME].filter(Boolean).join(' ').trim()
  const formId = String(r?.versionedLeadGenFormUrn ?? r?.leadGenFormUrn ?? '').split(':').pop().split(',')[0] || null
  const known = new Set(['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE_NUMBER', 'WORK_EMAIL', 'WORK_PHONE_NUMBER'])
  const answers = Object.fromEntries(Object.entries(values).filter(([k, v]) => !known.has(k) && v))
  return {
    name: name || 'LinkedIn lead',
    email: values.EMAIL ?? values.WORK_EMAIL ?? null,
    phone: values.PHONE_NUMBER ?? values.WORK_PHONE_NUMBER ?? null,
    course_id: config.form_courses?.[formId] ?? config.default_course_id ?? null,
    platform_lead_id: String(r?.id ?? ''),
    source_meta: {
      campaign: r?.leadMetadata?.sponsoredLeadMetadata?.campaign ?? undefined,
      form: formId ?? undefined,
      answers: Object.keys(answers).length ? answers : undefined,
      submitted_at: r?.submittedAt ? new Date(r.submittedAt).toISOString() : undefined,
    },
    consent: { platform: 'linkedin', consents: r?.formResponse?.consentResponses ?? undefined },
    submitted_at_ms: Number(r?.submittedAt) || null,
  }
}
