// src/utils/token.js

import jwt from 'jsonwebtoken'
import env from '../config/env.js'

const generateAccessToken = (payload) => {
  return jwt.sign(payload, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
    algorithm: 'HS256',
  })
}

const generateRefreshToken = (payload) => {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiresIn,
    algorithm: 'HS256',
  })
}

const verifyAccessToken = (token) => {
  return jwt.verify(token, env.jwt.secret)
}

const verifyRefreshToken = (token) => {
  return jwt.verify(token, env.jwt.refreshSecret)
}

const getRefreshTokenExpiry = () => {
  const date = new Date()
  date.setDate(date.getDate() + 7)
  return date
}

export default {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  getRefreshTokenExpiry,
}
