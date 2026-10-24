// src/app.js

import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import morgan from 'morgan'
import cookieParser from 'cookie-parser'

import env from './config/env.js'
import './config/passport.js'
import errorHandler from './middleware/errorHandler.js'
import { apiLimiter } from './middleware/rateLimit.js'

import authRoutes from './modules/auth/auth.routes.js'
import categoryRoutes from './modules/categories/categories.routes.js'
import courseRoutes from './modules/courses/courses.routes.js'
import sectionRoutes from './modules/sections/sections.routes.js'
import lessonRoutes from './modules/lessons/lessons.routes.js'
import testRoutes from './modules/tests/tests.routes.js'
import questionRoutes from './modules/questions/questions.routes.js'
import optionRoutes from './modules/options/options.routes.js'
import enrollmentRoutes from './modules/enrollments/enrollments.routes.js'
import attemptRoutes from './modules/attempts/attempts.routes.js'
import progressRoutes from './modules/progress/progress.routes.js'
import paymentRoutes from './modules/payments/payments.routes.js'
import discountRoutes from './modules/discounts/discounts.routes.js'
import certificateRoutes from './modules/certificates/certificates.routes.js'
import reviewRoutes from './modules/reviews/reviews.routes.js'
import adminRoutes from './modules/admin/admin.routes.js'
import contactRoutes from './modules/contact/contact.routes.js'
import uploadRoutes from './modules/upload/upload.routes.js'

const API_PREFIX = '/api/v1'

const ROUTES = [
  ['/auth', authRoutes],
  ['/categories', categoryRoutes],
  ['/courses', courseRoutes],
  ['/sections', sectionRoutes],
  ['/lessons', lessonRoutes],
  ['/tests', testRoutes],
  ['/questions', questionRoutes],
  ['/options', optionRoutes],
  ['/enrollments', enrollmentRoutes],
  ['/attempts', attemptRoutes],
  ['/progress', progressRoutes],
  ['/payments', paymentRoutes],
  ['/discounts', discountRoutes],
  ['/certificates', certificateRoutes],
  ['/reviews', reviewRoutes],
  ['/admin', adminRoutes],
  ['/contact', contactRoutes],
  ['/upload', uploadRoutes],
]

const app = express()

// Behind nginx / a load balancer: needed for correct client IPs (rate limiting)
// and secure cookies.
app.set('trust proxy', 1)

// ─── SECURITY ────────────────────────────────────────────────
app.use(helmet())
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server calls / curl (no Origin header) and whitelisted origins
      if (!origin || env.corsOrigins.includes(origin)) return callback(null, true)
      return callback(null, false)
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
)

// Razorpay webhook needs the raw body for signature verification — must run
// before express.json().
app.use(`${API_PREFIX}/payments/razorpay/webhook`, express.raw({ type: 'application/json' }))
app.use('/api/payments/razorpay/webhook', express.raw({ type: 'application/json' })) // legacy path

// ─── BODY PARSING ────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// ─── LOGGING ─────────────────────────────────────────────────
if (!env.isProd) {
  app.use(morgan('dev'))
}

// ─── RATE LIMIT ──────────────────────────────────────────────
app.use('/api/', apiLimiter)

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ success: true, message: `${env.appName} API is running`, env: env.NODE_ENV })
})

// ─── ROUTES ──────────────────────────────────────────────────
ROUTES.forEach(([path, router]) => app.use(`${API_PREFIX}${path}`, router))

// ─── 404 ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' })
})

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────
app.use(errorHandler)

export default app
