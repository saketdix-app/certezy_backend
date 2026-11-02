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
