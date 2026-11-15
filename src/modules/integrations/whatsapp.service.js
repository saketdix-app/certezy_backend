// src/modules/integrations/whatsapp.service.js
// 2.0 Phase 8 — WhatsApp conversations on leads.
//   • Inbound from a known number → saved on that lead's thread, owner notified.
//   • Inbound from a new number → becomes a lead (source "whatsapp") through
//     the same intake pipeline as Meta/LinkedIn (duplicates, Round Robin).
//   • Replies from the lead panel: free text only within 24 hours of the
//     person's last message (WhatsApp's rule); otherwise an approved template.

import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { notify } from '../../utils/notify.js'
import { getLead } from '../crm/leads.service.js'
import { getIntegration, processEvent, recordEvent } from './ingest.service.js'
import * as wa from './whatsapp.adapter.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const WINDOW_HOURS = 24

const leadByPhone = async (waId) => {
  const last10 = String(waId).slice(-10)
  const [[lead]] = await pool.query(
    'SELECT id, name, owner_id FROM leads WHERE phone_norm = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1',
    [last10]
  )
  return lead ?? null
}

/** One inbound message from the webhook. Never throws. */
export const handleInbound = async (msg) => {
  try {
    const [dup] = await pool.query('SELECT id FROM whatsapp_messages WHERE wa_message_id = ?', [msg.id])
    if (dup.length) return 'duplicate' // webhook retry
    let lead = await leadByPhone(msg.from)
    let created = false
    if (!lead) {
      const integration = await getIntegration('whatsapp')
      if (integration.enabled) {
        const { id, isNew } = await recordEvent('whatsapp', msg.id, {
          lead: {
            name: msg.name || `WhatsApp +${msg.from}`,
            phone: `+${msg.from}`,
            email: null,
            course_id: integration.config?.default_course_id ?? null,
            platform_lead_id: `wa-${msg.from}`,
            source_meta: { form: 'whatsapp', answers: { first_message: String(msg.text ?? '').slice(0, 300) } },
            consent: { platform: 'whatsapp', note: 'Messaged CERTEZY on WhatsApp' },
          },
        })
        if (isNew) await processEvent(id)
        lead = await leadByPhone(msg.from)
        created = Boolean(lead)
      }
    }
    await pool.query(
      `INSERT IGNORE INTO whatsapp_messages (lead_id, direction, wa_id, wa_message_id, kind, body, status, created_at)
       VALUES (?, 'in', ?, ?, ?, ?, 'received', COALESCE(FROM_UNIXTIME(?), UTC_TIMESTAMP()))`,
      [lead?.id ?? null, msg.from, msg.id, msg.type === 'text' ? 'text' : msg.type ?? 'text', msg.text ?? '', msg.timestamp]
    )
    if (lead && !created) {
      await pool.query("INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, NULL, 'whatsapp_in', ?, NULL)", [
        lead.id,
        String(msg.text ?? '').slice(0, 2000),
      ])
      if (lead.owner_id) {
        await notify(lead.owner_id, {
          type: 'whatsapp',
          title: `WhatsApp from ${lead.name}`,
          body: String(msg.text ?? '').slice(0, 140),
          link: `/consultant/leads?lead=${lead.id}`,
        })
      }
    }
    return lead ? (created ? 'new_lead' : 'saved') : 'unmatched'
  } catch (err) {
    console.error('WhatsApp inbound failed:', err.message)
    return 'error'
  }
}

/** Delivery updates for messages we sent (sent → delivered → read, or failed). */
export const handleStatus = async ({ id, status, error }) => {
  await pool
    .query("UPDATE whatsapp_messages SET status = ?, error = ? WHERE wa_message_id = ? AND direction = 'out'", [status, error, id])
    .catch(() => {})
}

/** The lead's conversation, oldest first, plus whether free text is allowed now. */
export const thread = async (actor, leadId) => {
  const lead = await getLead(actor, leadId)
  const [messages] = await pool.query(
    `SELECT m.id, m.direction, m.kind, m.body, m.template, m.status, m.error, m.created_at, u.name AS sent_by_name
     FROM whatsapp_messages m LEFT JOIN users u ON u.id = m.sent_by
     WHERE m.lead_id = ? ORDER BY m.id ASC LIMIT 300`,
    [lead.id]
  )
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in')
  const windowOpen = Boolean(lastIn && Date.now() - new Date(lastIn.created_at).getTime() < WINDOW_HOURS * 3600e3)
  return {
    messages,
    window_open: windowOpen,
    window_closes_at: windowOpen ? new Date(new Date(lastIn.created_at).getTime() + WINDOW_HOURS * 3600e3) : null,
    can_send: Boolean(lead.phone),
  }
}

/** Send from the lead panel: { text } inside the 24-hour window, else { template, language, params }. */
export const sendFromLead = async (req, leadId, { text, template, language, params }) => {
  const actor = req.user
  const lead = await getLead(actor, leadId)
  if (!lead.phone) throw fail(400, 'This lead has no phone number')
  const integration = await getIntegration('whatsapp')
  if (!integration.enabled) throw fail(400, 'WhatsApp is turned off (Admin → Integrations)')
  const { window_open: open } = await thread(actor, leadId)

  let waMessageId
  let kind
  let body
  if (text?.trim()) {
    if (!open) throw fail(400, 'It has been more than 24 hours since they last wrote — send an approved template instead')
    body = text.trim()
    kind = 'text'
    waMessageId = await wa.sendText(lead.phone, body)
  } else if (template) {
    kind = 'template'
    body = `[${template}] ${(params ?? []).join(' · ')}`.trim()
    waMessageId = await wa.sendTemplate(lead.phone, template, language, params ?? [])
  } else {
    throw fail(400, 'Write a message or choose a template')
  }

  await pool.query(
    `INSERT INTO whatsapp_messages (lead_id, direction, wa_id, wa_message_id, kind, body, template, status, sent_by)
     VALUES (?, 'out', ?, ?, ?, ?, ?, 'sent', ?)`,
    [lead.id, wa.toWaId(lead.phone), waMessageId, kind, body, template ?? null, actor.id]
  )
  await pool.query("INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, ?, 'whatsapp', ?, ?)", [
    lead.id,
    actor.id,
    body.slice(0, 2000),
    JSON.stringify({ via: 'whatsapp_api', template: template ?? undefined }),
  ])
  await pool.query('UPDATE leads SET first_contact_at = COALESCE(first_contact_at, UTC_TIMESTAMP()) WHERE id = ?', [lead.id])
  await audit(req, { action: 'whatsapp.send', targetType: 'lead', targetId: lead.id, details: { kind, template } })
  return thread(actor, leadId)
}
