// src/modules/integrations/linkedinVersion.js
// LinkedIn's REST API needs a "LinkedIn-Version: YYYYMM" header. Each monthly
// version works for about a year, then LinkedIn answers 426 ("requested
// version is not active"). Instead of a fixed number that silently expires,
// use last month's version and, on a 426 (or a version not released yet),
// step back a month at a time. The version that works is remembered.
// LINKEDIN_API_VERSION, if set, is tried first.

import env from '../../config/env.js'

const MAX_TRIES = 6
let working = null

const yyyymm = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`

/** Versions to try, newest first: the configured one, then last month back 11 months. */
export const candidateVersions = (now = new Date(), configured = env.integrations.linkedin.version) => {
  const list = []
  if (/^\d{6}$/.test(configured ?? '')) list.push(configured)
  for (let back = 1; back <= 11; back++) {
    const v = yyyymm(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)))
    if (!list.includes(v)) list.push(v)
  }
  return list
}

export const currentLinkedInVersion = () => working ?? candidateVersions()[0]

// 426 = retired version; 400/404 that mention the version = not released / unknown
const versionRejected = async (res) => {
  if (res.status === 426) return true
  if (res.status !== 400 && res.status !== 404) return false
  const text = await res.clone?.().text().catch(() => '') ?? ''
  return /version/i.test(text)
}

/**
 * fetch() for api.linkedin.com/rest with a version that LinkedIn accepts.
 * `headers` should not include LinkedIn-Version.
 */
export const linkedInFetch = async (url, { headers = {}, ...opts } = {}, fetchImpl = fetch) => {
  const list = candidateVersions()
  const order = working ? [working, ...list.filter((v) => v !== working)] : list
  let res
  for (const version of order.slice(0, MAX_TRIES)) {
    res = await fetchImpl(url, { ...opts, headers: { ...headers, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' } })
    if (!(await versionRejected(res))) {
      if (working !== version) {
        if (working) console.warn(`LinkedIn API version ${working} no longer accepted — now using ${version}`)
        working = version
      }
      return res
    }
  }
  return res
}

/** For tests. */
export const resetLinkedInVersion = () => {
  working = null
}
