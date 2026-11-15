// src/utils/secretBox.js
// Encrypt small secrets for storage (integration API keys saved from the admin
// portal). AES-256-GCM: confidential and tamper-evident.
// Key: SECRETS_ENCRYPTION_KEY (32 bytes, base64 or hex) if set, otherwise
// derived from JWT_SECRET with HKDF — so changing JWT_SECRET (without setting
// SECRETS_ENCRYPTION_KEY) makes saved secrets unreadable; re-enter them then.

import crypto from 'node:crypto'

const parseKey = (raw) => {
  if (!raw) return null
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  return buf.length === 32 ? buf : null
}

export const keyFrom = (explicit, fallbackSecret) =>
  parseKey(explicit) ??
  Buffer.from(crypto.hkdfSync('sha256', String(fallbackSecret ?? ''), 'certezy', 'integration-secrets-v1', 32))

/** → "v1:<iv>:<tag>:<ciphertext>" (base64 parts) */
export const seal = (plaintext, key) => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}

/** Throws if the value was tampered with or the key changed. */
export const open = (sealed, key) => {
  const [v, iv, tag, ct] = String(sealed).split(':')
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised secret format')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8')
}
