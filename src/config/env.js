// src/config/env.js
// Single source of truth for configuration.
// Required variables are validated at boot — the process exits if any are missing.

import dotenv from 'dotenv'

dotenv.config()

const REQUIRED = [
  'PORT',
  'NODE_ENV',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'JWT_SECRET',
  'JWT_EXPIRES_IN',
  'REFRESH_TOKEN_SECRET',
  'REFRESH_TOKEN_EXPIRES_IN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALLBACK_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
  'FRONTEND_URL',
]

const missing = REQUIRED.filter((key) => !process.env[key])

if (missing.length > 0) {
  console.error(`\nMissing required environment variables:\n${missing.join('\n')}\n`)
  process.exit(1)
}

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

const toList = (value) =>
  (value || '')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean)

const NODE_ENV = process.env.NODE_ENV || 'development'
const isProd = NODE_ENV === 'production'
const frontendUrl = process.env.FRONTEND_URL.replace(/\/$/, '')

const env = {
  // Server
  PORT: toInt(process.env.PORT, 5000),
  NODE_ENV,
  isProd,
  appName: process.env.APP_NAME || 'Certezy',

  // Database
  db: {
    host: process.env.DB_HOST,
    port: toInt(process.env.DB_PORT, 3306),
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    poolMin: toInt(process.env.DB_POOL_MIN, 5),
    poolMax: toInt(process.env.DB_POOL_MAX, 50),
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret: process.env.REFRESH_TOKEN_SECRET,
    refreshExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
  },

  // Auth cookies
  // Use COOKIE_SAMESITE=none (with HTTPS) when frontend and API are on different sites.
  cookie: {
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
    sameSite: process.env.COOKIE_SAMESITE || (isProd ? 'strict' : 'lax'),
    domain: process.env.COOKIE_DOMAIN || undefined,
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: toInt(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // OAuth
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL,
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackUrl: process.env.GITHUB_CALLBACK_URL,
  },

  // Email
  smtp: {
    host: process.env.SMTP_HOST,
    port: toInt(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM,
  },

  // AWS S3
  s3: {
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'ap-south-1',
    bucket: process.env.AWS_BUCKET_NAME,
  },

  // DigitalOcean Spaces
  spaces: {
    region: process.env.SPACES_REGION,
    accessKey: process.env.SPACES_ACCESS_KEY,
    secretKey: process.env.SPACES_SECRET_KEY,
    bucket: process.env.SPACES_BUCKET,
  },

  // Payments
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    mode: process.env.PAYPAL_MODE || 'sandbox',
  },

  // Frontend / CORS
  frontendUrl,
  corsOrigins: [...new Set([frontendUrl, ...toList(process.env.CORS_ORIGINS)])],
}

export default env
