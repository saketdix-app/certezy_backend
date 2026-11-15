// src/modules/integrations/whatsapp.adapter.js
// WhatsApp Cloud API (Meta) — 2.0 phase 8 (PRD §8 WhatsApp).
// Inbound: webhook "messages" (texts, statuses). Outbound: free text inside
// the 24-hour customer-service window, approved templates outside it.

import { getCredentials } from './credentials.js'

const graph = (version) => `https://graph.facebook.com/${version}`

/** Messages and delivery statuses from a webhook body. */
export const parseWebhook = (body) => {
  const messages = []
  const statuses = []
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue
      const v = change.value ?? {}
      const names = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]))
      for (const m of v.messages ?? []) {
        const text =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          (m.type && m.type !== 'text' ? `[${m.type}]` : '')
        messages.push({ id: m.id, from: String(m.from), name: names[m.from] ?? null, type: m.type, text, timestamp: Number(m.timestamp) || null })
      }
      for (const s of v.statuses ?? []) {
        statuses.push({ id: s.id, status: s.status, error: s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? null })
      }
    }
  }
  return { messages, statuses }
}

const post = async (payload, fetchImpl) => {
  const { token, phoneNumberId, graphVersion } = await getCredentials('whatsapp')
  if (!token || !phoneNumberId) throw Object.assign(new Error('WhatsApp keys are not set (Admin → Integrations)'), { statusCode: 400 })
  const res = await fetchImpl(`${graph(graphVersion)}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`WhatsApp: ${data?.error?.message ?? `error ${res.status}`}`), { statusCode: 502 })
  return data.messages?.[0]?.id ?? null
}

/** Digits only, as WhatsApp expects ("+91 98765-43210" → "919876543210"). */
export const toWaId = (phone) => String(phone ?? '').replace(/\D/g, '')

export const sendText = (to, text, { fetchImpl = fetch } = {}) =>
  post({ to: toWaId(to), type: 'text', text: { body: text, preview_url: true } }, fetchImpl)

export const sendTemplate = (to, name, language, params = [], { fetchImpl = fetch } = {}) =>
  post(
    {
      to: toWaId(to),
      type: 'template',
      template: {
        name,
        language: { code: language || 'en' },
        ...(params.length && { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] }),
      },
    },
    fetchImpl
  )

/** Approved templates (needs the WhatsApp business account ID). */
export const listTemplates = async ({ fetchImpl = fetch } = {}) => {
  const { token, businessAccountId, graphVersion } = await getCredentials('whatsapp')
  if (!token || !businessAccountId) return []
  const res = await fetchImpl(`${graph(graphVersion)}/${businessAccountId}/message_templates?status=APPROVED&limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`WhatsApp: ${data?.error?.message ?? `error ${res.status}`}`), { statusCode: 502 })
  return (data.data ?? []).map((t) => {
    const body = t.components?.find((c) => c.type === 'BODY')?.text ?? ''
    return { name: t.name, language: t.language, category: t.category, body, params: (body.match(/\{\{\d+\}\}/g) ?? []).length }
  })
}
