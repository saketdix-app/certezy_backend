// src/middleware/auth.js

import tokenUtil from '../utils/token.js'
import * as queries from '../modules/auth/auth.queries.js'
import { rememberCountry } from '../utils/geo.js'
import { pool } from '../config/db.js'
import { IDLE_MINUTES, STAFF_PERMISSIONS } from '../constants.js'

// Activity is written at most this often per session (keeps writes low)
const TOUCH_EVERY_SECONDS = 30

/**
 * Idle sign-out. The access token carries its session id (sid). A session with
 * no activity for 15 min (Super Admin) / 60 min (everyone else) is ended.
 * Background polls (header X-Activity: background) are checked but don't count
 * as activity. Returns an error to send, or null.
 */
const checkSession = async (req, decoded, user) => {
  if (!decoded.sid) return null // older token (from before idle sign-out): it expires within 15 min anyway
  const [[s]] = await pool.query(
    `SELECT id, client, TIMESTAMPDIFF(SECOND, COALESCE(last_activity_at, UTC_TIMESTAMP()), UTC_TIMESTAMP()) AS idle
     FROM refresh_tokens WHERE id = ? AND user_id = ? LIMIT 1`,
    [decoded.sid, user.id]
  )
  if (!s) return Object.assign(new Error('Your session has ended. Please sign in again.'), { statusCode: 401, publicCode: 'SESSION_ENDED' })
  const limit = (IDLE_MINUTES[user.role] ?? IDLE_MINUTES.default) * 60
  // The Team app stays signed in like other phone apps (Super Admins keep the 15-minute rule)
  const appSession = s.client === 'mobile' && user.role !== 'super_admin'
  if (!appSession && Number(s.idle) > limit) {
    await pool.query('DELETE FROM refresh_tokens WHERE id = ?', [s.id])
    return Object.assign(new Error(`You were signed out after ${limit / 60} minutes without activity`), {
      statusCode: 401,
      publicCode: 'SESSION_IDLE',
    })
  }
  const background = String(req.get?.('x-activity') ?? '').toLowerCase() === 'background'
  if (!background && Number(s.idle) >= TOUCH_EVERY_SECONDS) {
    await pool.query('UPDATE refresh_tokens SET last_activity_at = UTC_TIMESTAMP() WHERE id = ?', [s.id])
  }
  return null
}

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null
    const token = req.cookies?.accessToken || bearerToken

    if (!token) {
      const err = new Error('Access token required')
      err.statusCode = 401
      return next(err)
    }

    let decoded
    try {
      decoded = tokenUtil.verifyAccessToken(token)
    } catch (e) {
      const err = new Error(e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token')
      err.statusCode = 401
      return next(err)
    }

    const user = await queries.findById(decoded.id)
    if (!user || !user.is_active) {
      const err = new Error('Account not found or deactivated')
      err.statusCode = 401
      return next(err)
    }

    const ended = await checkSession(req, decoded, user)
    if (ended) return next(ended)

    // Sub-Admins: what they may use (Team → Permissions)
    if (user.role === 'sub_admin') {
      const [[row]] = await pool.query('SELECT * FROM admin_permissions WHERE user_id = ? LIMIT 1', [user.id])
      user.permissions = Object.fromEntries(STAFF_PERMISSIONS.map((k) => [k, Boolean(row?.[k])]))
    }

    req.user = user
    rememberCountry(req, user.id)
    next()
  } catch (err) {
    next(err)
  }
}

export default authenticate
