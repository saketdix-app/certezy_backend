// src/middleware/auth.js

import tokenUtil from '../utils/token.js'
import * as queries from '../modules/auth/auth.queries.js'

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

    req.user = user
    next()
  } catch (err) {
    next(err)
  }
}

export default authenticate
