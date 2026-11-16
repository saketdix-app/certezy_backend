// src/modules/integrations/oauth.js
// "Connect with Facebook" / "Connect with LinkedIn" in Admin → Integrations.
//
// One-time, by hand (the platforms don't allow it by API): create the app,
// add our redirect URL to it, and (LinkedIn) get Lead Sync approved; then save
// the App ID + App secret / Client ID + Client secret on the card.
// After that a Super Admin clicks Connect, signs in, picks the Page or ad
// account, and we do the rest:
//   Meta     → long-lived Page token (doesn't expire), webhook verify token,
//              Page subscribed to the app, app webhook pointed at CERTEZY.
//   LinkedIn → access token (+ refresh token, renewed automatically before it
//              expires), ad account ID.
//
// Security: starting needs a Super Admin + password. `state` is signed and
// bound to that user; the finish call is an authenticated API call by the
// same user. Tokens never reach the browser — when there's a choice to make,
// the browser only holds an encrypted, short-lived selection blob.

import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import env from '../../config/env.js'
import { audit } from '../../utils/audit.js'
import { managerIds, notify } from '../../utils/notify.js'
import { keyFrom, open, seal } from '../../utils/secretBox.js'
import { notifySuperAdmins, reauthenticate } from '../team/team.service.js'
import { getCredentials, setCredentialValues } from './credentials.js'

export const OAUTH_SOURCES = ['meta', 'linkedin']
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const LABEL = { meta: 'Facebook', linkedin: 'LinkedIn' }

export const redirectUri = (source) => `${env.frontendUrl}/admin/integrations/connect/${source}`
export const webhookUrl = (source) => `${env.frontendUrl}/api/v1/webhooks/${source}`

const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_manage_ads',
  'leads_retrieval',
  'ads_management',
  'business_management',
]
// Lead Sync needs the first; r_ads lets us list ad accounts (Advertising API).
// If the app doesn't have r_ads, LinkedIn refuses the sign-in and we retry
// with the lead scope only (the ad account ID is then typed in by hand).
const LINKEDIN_SCOPES = { full: 'r_marketing_leadgen_automation r_ads', min: 'r_marketing_leadgen_automation' }

const stateSecret = () => `${env.jwt.secret}:integration-oauth`
const boxKey = () => keyFrom(env.secretsEncryptionKey, env.jwt.secret)
const graph = () => `https://graph.facebook.com/${env.integrations.meta.graphVersion}`
const LI_REST = 'https://api.linkedin.com/rest'

const requireSuper = async (req, source, action) => {
  if (!OAUTH_SOURCES.includes(source)) throw fail(404, 'This integration has no Connect option')
  if (req.user?.role !== 'super_admin') {
    await audit(req, { action, result: 'denied', targetType: 'integration', details: { source } })
    throw fail(403, 'Only a Super Admin can connect integrations')
  }
}

const jsonOf = async (res) => res.json().catch(() => ({}))
const errText = (data, status) =>
  data?.error?.error_user_msg ?? data?.error?.message ?? data?.error_description ?? data?.message ?? `error ${status}`

const authorizeUrl = (source, creds, state, scopes) => {
  if (source === 'meta') {
    const q = new URLSearchParams({ client_id: creds.appId, redirect_uri: redirectUri('meta'), state, scope: META_SCOPES.join(','), response_type: 'code' })
    return `https://www.facebook.com/${env.integrations.meta.graphVersion}/dialog/oauth?${q}`
  }
  const q = new URLSearchParams({ response_type: 'code', client_id: creds.clientId, redirect_uri: redirectUri('linkedin'), state, scope: LINKEDIN_SCOPES[scopes] })
  return `https://www.linkedin.com/oauth/v2/authorization?${q}`
}

const signState = (req, source, scopes = 'full') =>
  jwt.sign({ uid: req.user.id, source, scopes, n: crypto.randomBytes(8).toString('hex') }, stateSecret(), { expiresIn: '15m' })

const readState = (req, source, state) => {
  try {
    const s = jwt.verify(String(state ?? ''), stateSecret())
    if (s.uid === req.user.id && s.source === source) return s
  } catch {
    /* fall through */
  }
  throw fail(400, `This ${LABEL[source]} sign-in has expired or was started by someone else — click Connect again`)
}

const appKeys = async (source) => {
  const c = await getCredentials(source, { fresh: true })
  if (source === 'meta' && !(c.appId && c.appSecret)) throw fail(400, 'Save the Meta App ID and App secret first (one-time setup)')
  if (source === 'linkedin' && !(c.clientId && c.clientSecret)) throw fail(400, 'Save the LinkedIn Client ID and Client secret first (one-time setup)')
  return c
}

/** Step 1: Super Admin + password → the platform's sign-in URL. */
export const startConnect = async (req, source, password) => {
  await requireSuper(req, source, 'integration.connect')
  const creds = await appKeys(source)
  try {
    await reauthenticate(req.user, password)
  } catch (err) {
    await audit(req, { action: 'integration.connect', result: 'denied', targetType: 'integration', details: { source, reason: 'password' } })
    throw err
  }
  await audit(req, { action: 'integration.connect_start', targetType: 'integration', details: { source } })
  return { url: authorizeUrl(source, creds, signState(req, source), 'full') }
}

// Encrypted, short-lived "pick one" blob: holds tokens the browser can't read.
const sealSelection = (req, source, data) =>
  seal(JSON.stringify({ uid: req.user.id, source, exp: Date.now() + 15 * 60e3, ...data }), boxKey())
const openSelection = (req, source, blob) => {
  let s
  try {
    s = JSON.parse(open(blob, boxKey()))
  } catch {
    s = null
  }
  if (!s || s.uid !== req.user.id || s.source !== source || s.exp < Date.now()) {
    throw fail(400, 'This choice has expired — click Connect again')
  }
  return s
}

// ── Meta ──────────────────────────────────────────────────────────────────

const metaToken = async (params, fetchImpl) => {
  const res = await fetchImpl(`${graph()}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const data = await jsonOf(res)
  if (!res.ok || !data.access_token) throw fail(502, `Facebook: ${errText(data, res.status)}`)
  return data.access_token
}

const metaPages = async (userToken, fetchImpl) => {
  const res = await fetchImpl(`${graph()}/me/accounts?fields=id,name,access_token&limit=100`, { headers: { Authorization: `Bearer ${userToken}` } })
  const data = await jsonOf(res)
  if (!res.ok) throw fail(502, `Facebook: ${errText(data, res.status)}`)
  return (data.data ?? []).filter((p) => p.id && p.access_token).map((p) => ({ id: String(p.id), name: p.name, token: p.access_token }))
}

const metaPost = async (path, params, fetchImpl) => {
  const res = await fetchImpl(`${graph()}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const data = await jsonOf(res)
  return res.ok && data.success !== false ? { ok: true } : { ok: false, error: errText(data, res.status) }
}

const finishMeta = async (req, page, fetchImpl) => {
  const creds = await getCredentials('meta', { fresh: true })
  const verifyToken = creds.verifyToken || crypto.randomBytes(16).toString('hex')
  await setCredentialValues(
    'meta',
    {
      page_access_token: page.token,
      verify_token: verifyToken,
      connection: JSON.stringify({ page_id: page.id, page_name: page.name, connected_by: req.user.name, connected_at: new Date().toISOString() }),
    },
    req.user.id
  )
  const steps = [{ ok: true, label: `Page "${page.name}" connected (its token doesn't expire)` }]

  const sub = await metaPost(`${encodeURIComponent(page.id)}/subscribed_apps`, { subscribed_fields: 'leadgen', access_token: page.token }, fetchImpl)
  steps.push(sub.ok ? { ok: true, label: 'Page set to send new leads to the app' } : { ok: false, label: `Page subscription: ${sub.error}` })

  // Facebook calls our webhook straight away to check the verify token (saved above)
  const hook = await metaPost(
    `${encodeURIComponent(creds.appId)}/subscriptions`,
    {
      object: 'page',
      callback_url: webhookUrl('meta'),
      fields: 'leadgen',
      verify_token: verifyToken,
      include_values: 'true',
      access_token: `${creds.appId}|${creds.appSecret}`,
    },
    fetchImpl
  )
  steps.push(hook.ok ? { ok: true, label: 'Webhook pointed at CERTEZY' } : { ok: false, label: `Webhook: ${hook.error}` })
  return { source: 'meta', name: page.name, steps }
}

// ── LinkedIn ──────────────────────────────────────────────────────────────

const linkedInToken = async (params, fetchImpl) => {
  const res = await fetchImpl('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const data = await jsonOf(res)
  if (!res.ok || !data.access_token) throw fail(502, `LinkedIn: ${errText(data, res.status)}`)
  const now = Date.now()
  return {
    access: data.access_token,
    refresh: data.refresh_token ?? '',
    expires_at: new Date(now + Number(data.expires_in ?? 5184000) * 1000).toISOString(),
    refresh_expires_at: data.refresh_token_expires_in ? new Date(now + Number(data.refresh_token_expires_in) * 1000).toISOString() : null,
  }
}

const liHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'LinkedIn-Version': env.integrations.linkedin.version,
  'X-Restli-Protocol-Version': '2.0.0',
})

/** Ad accounts this person can use. [] when the app can't list them (no r_ads). */
const linkedInAccounts = async (token, fetchImpl) => {
  const res = await fetchImpl(`${LI_REST}/adAccountUsers?q=authenticatedUser`, { headers: liHeaders(token) })
  if (!res.ok) return []
  const data = await jsonOf(res)
  const ids = [...new Set((data.elements ?? []).map((e) => String(e.account ?? '').split(':').pop()).filter(Boolean))]
  const out = []
  for (const id of ids.slice(0, 50)) {
    const r = await fetchImpl(`${LI_REST}/adAccounts/${encodeURIComponent(id)}`, { headers: liHeaders(token) }).catch(() => null)
    const d = r?.ok ? await jsonOf(r) : {}
    out.push({ id, name: d.name ?? `Ad account ${id}` })
  }
  return out
}

const finishLinkedIn = async (req, tokens, account) => {
  const connection = {
    account_id: account?.id ?? null,
    account_name: account?.name ?? null,
    connected_by: req.user.name,
    connected_at: new Date().toISOString(),
    expires_at: tokens.expires_at,
    refresh_expires_at: tokens.refresh_expires_at,
    auto_renew: Boolean(tokens.refresh),
  }
  await setCredentialValues(
    'linkedin',
    {
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      ...(account && { ad_account_id: account.id }),
      connection: JSON.stringify(connection),
    },
    req.user.id
  )
  const until = (iso) => new Date(iso).toDateString()
  const steps = [
    { ok: true, label: 'LinkedIn access token saved' },
    account
      ? { ok: true, label: `Ad account "${account.name}" selected` }
      : { ok: false, label: "This app can't list ad accounts — type the Ad account ID under Change keys" },
    tokens.refresh
      ? { ok: true, label: `Renews automatically (until ${until(tokens.refresh_expires_at ?? tokens.expires_at)})` }
      : { ok: false, label: `LinkedIn gave no renewal token — click Connect again before ${until(tokens.expires_at)}` },
  ]
  return { source: 'linkedin', name: account?.name ?? 'LinkedIn', steps }
}

// ── Finish (the browser comes back from the platform) ─────────────────────

const done = async (req, result) => {
  await audit(req, {
    action: 'integration.connect',
    targetType: 'integration',
    details: { source: result.source, connected_to: result.name, steps: result.steps.map((s) => `${s.ok ? 'ok' : 'failed'}: ${s.label}`) },
  })
  await notifySuperAdmins(`${LABEL[result.source]} was connected to CERTEZY`, [`Connected to: ${result.name}`, `By: ${req.user.name}`], req.user.id)
  return { status: 'done', name: result.name, steps: result.steps }
}

/**
 * Step 2: { code, state } (or { error, state }) from the platform's redirect.
 * → { status: 'done', steps } | { status: 'choose', options, selection } | { status: 'redirect', url }
 */
export const finishConnect = async (req, source, { code, state, error }, { fetchImpl = fetch } = {}) => {
  await requireSuper(req, source, 'integration.connect')
  const s = readState(req, source, state)
  const creds = await appKeys(source)

  if (error) {
    // The app hasn't got r_ads: sign in again asking for the lead scope only
    if (source === 'linkedin' && error === 'unauthorized_scope_error' && s.scopes === 'full') {
      return { status: 'redirect', url: authorizeUrl('linkedin', creds, signState(req, source, 'min'), 'min') }
    }
    throw fail(400, ['access_denied', 'user_cancelled_authorize', 'user_cancelled_login'].includes(error) ? 'Sign-in was cancelled' : `${LABEL[source]} refused the sign-in (${error})`)
  }
  if (!code) throw fail(400, 'Missing sign-in code — click Connect again')

  if (source === 'meta') {
    const shortLived = await metaToken({ client_id: creds.appId, client_secret: creds.appSecret, redirect_uri: redirectUri('meta'), code }, fetchImpl)
    // Page tokens from a long-lived user token don't expire
    const longLived = await metaToken({ grant_type: 'fb_exchange_token', client_id: creds.appId, client_secret: creds.appSecret, fb_exchange_token: shortLived }, fetchImpl)
    const pages = await metaPages(longLived, fetchImpl)
    if (!pages.length) throw fail(400, 'No Facebook Pages came back — click Connect again and tick your Page when Facebook asks')
    if (pages.length === 1) return done(req, await finishMeta(req, pages[0], fetchImpl))
    return { status: 'choose', options: pages.map(({ id, name }) => ({ id, name })), selection: sealSelection(req, source, { pages }) }
  }

  const tokens = await linkedInToken(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri('linkedin'), client_id: creds.clientId, client_secret: creds.clientSecret },
    fetchImpl
  )
  const accounts = await linkedInAccounts(tokens.access, fetchImpl)
  if (accounts.length <= 1) return done(req, await finishLinkedIn(req, tokens, accounts[0]))
  return { status: 'choose', options: accounts, selection: sealSelection(req, source, { tokens, accounts }) }
}

/** Step 3 (only when there was more than one Page / ad account). */
export const chooseConnect = async (req, source, { selection, id }, { fetchImpl = fetch } = {}) => {
  await requireSuper(req, source, 'integration.connect')
  const s = openSelection(req, source, selection)
  if (source === 'meta') {
    const page = s.pages.find((p) => p.id === String(id))
    if (!page) throw fail(400, 'Choose one of the listed Pages')
    return done(req, await finishMeta(req, page, fetchImpl))
  }
  const account = s.accounts.find((a) => a.id === String(id))
  if (!account) throw fail(400, 'Choose one of the listed ad accounts')
  return done(req, await finishLinkedIn(req, s.tokens, account))
}

// ── LinkedIn renewal (queue worker, every few hours) ──────────────────────

const RENEW_DAYS = 7
const today = () => new Date().toISOString().slice(0, 10)

/** Renew the LinkedIn token in its last week; warn the Admins (once a day) if it can't be. */
export const renewLinkedIn = async ({ fetchImpl = fetch, now = Date.now() } = {}) => {
  const c = await getCredentials('linkedin', { fresh: true })
  const conn = c.connection
  if (!conn?.expires_at || !c.accessToken) return 'not_connected'
  const daysLeft = (new Date(conn.expires_at).getTime() - now) / 86400e3
  if (daysLeft > RENEW_DAYS) return 'ok'

  if (c.refreshToken && c.clientId && c.clientSecret) {
    try {
      const t = await linkedInToken(
        { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret },
        fetchImpl
      )
      await setCredentialValues('linkedin', {
        access_token: t.access,
        refresh_token: t.refresh || c.refreshToken,
        connection: JSON.stringify({ ...conn, expires_at: t.expires_at, refresh_expires_at: t.refresh_expires_at ?? conn.refresh_expires_at, warned_on: null }),
      })
      await audit(null, { action: 'integration.token_renewed', targetType: 'integration', details: { source: 'linkedin' } })
      return 'renewed'
    } catch (err) {
      console.error('LinkedIn token renewal failed:', err.message)
    }
  }
  if (conn.warned_on === today()) return 'warned'
  await notify(await managerIds(), {
    type: 'integration',
    title: daysLeft > 0 ? `LinkedIn connection ends in ${Math.max(1, Math.ceil(daysLeft))} day(s)` : 'LinkedIn connection has ended',
    body: 'A Super Admin needs to click Connect with LinkedIn again in Admin → Integrations',
    link: '/admin/integrations',
  })
  await setCredentialValues('linkedin', { connection: JSON.stringify({ ...conn, warned_on: today() }) })
  return 'warned'
}
