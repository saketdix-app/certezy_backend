// src/modules/integrations/signature.js
// Webhook signature checks (PRD §8: verify signatures where supported).

import crypto from 'node:crypto'

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex')

/** Constant-time compare of two hex strings. */
const safeEqualHex = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/** Meta: header "X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>". */
export const verifyMetaSignature = (rawBody, header, appSecret) => {
  if (!appSecret || !rawBody || !header?.startsWith('sha256=')) return false
  return safeEqualHex(header.slice(7), hmacHex(appSecret, rawBody))
}

/** LinkedIn: header "X-LI-Signature: hmacsha256=<hex HMAC of the raw body with the client secret>". */
export const verifyLinkedInSignature = (rawBody, header, clientSecret) => {
  if (!clientSecret || !rawBody || !header) return false
  const value = header.startsWith('hmacsha256=') ? header.slice(11) : header
  return safeEqualHex(value, hmacHex(clientSecret, rawBody))
}

/** LinkedIn webhook validation: challengeResponse = hex HMAC of the challenge code. */
export const linkedInChallengeResponse = (challengeCode, clientSecret) => hmacHex(clientSecret, String(challengeCode))
