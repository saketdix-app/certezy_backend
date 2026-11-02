// src/utils/geo.js
// Visitor country from the request IP (offline GeoLite data via geoip-lite).
// Decides the pricing region server-side, so it can't be changed in the browser:
//   India (IN)  → INR prices, Razorpay
//   elsewhere   → USD prices, PayPal
//
// nginx forwards the client IP (X-Forwarded-For) and app.js sets
// `trust proxy`, so req.ip is the visitor's address.
// GEO_FORCE_COUNTRY (e.g. "US") overrides it — for local development only.

import geoip from 'geoip-lite'
import { pool } from '../config/db.js'

const cleanIp = (ip = '') =>
  String(ip)
    .replace(/^::ffff:/, '')
    .trim()

/** Two-letter country code, or null when unknown (private / local IPs). */
export const countryForRequest = (req) => {
  if (process.env.GEO_FORCE_COUNTRY) return process.env.GEO_FORCE_COUNTRY.toUpperCase()
  const ip = cleanIp(req.ip || req.socket?.remoteAddress)
  return geoip.lookup(ip)?.country ?? null
}

/** 'INR' for India, 'USD' for everyone else (and when the country is unknown). */
export const currencyForCountry = (country) => (country === 'IN' ? 'INR' : 'USD')

export const regionForRequest = (req) => {
  const country = countryForRequest(req)
  return { country, currency: currencyForCountry(country) }
}

// ── Remember where each signed-in user is from (admin country reports) ──────
// Saved once, when users.country is still empty. Checked at most once per user
// per process, so it costs one small UPDATE per user after a restart.
const seen = new Set()

export const rememberCountry = (req, userId) => {
  if (!userId || seen.has(userId) || process.env.GEO_FORCE_COUNTRY) return
  seen.add(userId)
  const country = countryForRequest(req)
  if (!country) return
  pool
    .query('UPDATE users SET country = ? WHERE id = ? AND country IS NULL', [country, userId])
    .catch(() => seen.delete(userId)) // e.g. column not migrated yet — try again later
}
