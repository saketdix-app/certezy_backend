// src/middleware/rateLimit.js

import rateLimit from 'express-rate-limit'
import env from '../config/env.js'

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.isProd ? 5 : 500,
  message: { success: false, message: 'Too many login attempts. Try after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.isProd ? 10 : 500,
  message: { success: false, message: 'Too many registrations from this IP.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Forgot-password emails: a few per hour per IP (stops inbox flooding)
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.isProd ? 5 : 500,
  message: { success: false, message: 'Too many reset requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Course-page enquiry forms: enough for a real person (and a shared office IP), not for a bot
const enquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.isProd ? 12 : 500,
  message: { success: false, message: 'Too many requests. Please try again later or contact us by email.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Guest checkout: starting / finishing payments without a login
const guestCheckoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.isProd ? 30 : 500,
  message: { success: false, message: 'Too many checkout attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export { loginLimiter, registerLimiter, apiLimiter, passwordResetLimiter, enquiryLimiter, guestCheckoutLimiter }
