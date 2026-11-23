// src/utils/token.js

import jwt from 'jsonwebtoken'
import env from '../config/env.js'

const generateAccessToken = (payload) => {
  return jwt.sign(payload, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
    algorithm: 'HS256',
  })
}

const generateRefreshToken = (payload, expiresIn = env.jwt.refreshExpiresIn) => {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn,
    algorithm: 'HS256',
  })
}

// Only HS256 is accepted (never 'none' or another algorithm)
const verifyAccessToken = (token) => {
  return jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'] })
}

const verifyRefreshToken = (token) => {
  return jwt.verify(token, env.jwt.refreshSecret, { algorithms: ['HS256'] })
}

const getRefreshTokenExpiry = (days = 7) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date
}

export default {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  getRefreshTokenExpiry,
}
