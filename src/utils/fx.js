// src/utils/fx.js
// USD → INR rate for showing / charging Indian prices of courses that have no
// rupee price set. Kept in memory and refreshed in the background, so pricing
// stays synchronous and never waits on (or fails because of) the rate service.

import axios from 'axios'

const FALLBACK_RATE = 84.5
const REFRESH_MS = 6 * 60 * 60 * 1000

let rate = FALLBACK_RATE
let fetchedAt = 0
let inflight = null

const refresh = () => {
  inflight ??= axios
    .get('https://api.frankfurter.app/latest?from=USD&to=INR', { timeout: 8000 })
    .then(({ data }) => {
      const r = Number(data?.rates?.INR)
      if (r > 0) {
        rate = r
        fetchedAt = Date.now()
      }
    })
    .catch(() => {})
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Current USD→INR rate (last known; triggers a background refresh when stale). */
export const usdToInrRate = () => {
  if (Date.now() - fetchedAt > REFRESH_MS) refresh()
  return rate
}

/** Whole rupees, e.g. 699 USD-cents worth → ₹ 59,066 */
export const usdToInr = (usd) => Math.round(Number(usd || 0) * usdToInrRate())

/** Warm the cache at startup. */
export const primeFxRate = () => refresh()
