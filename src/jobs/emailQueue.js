// src/jobs/emailQueue.js

import { Queue } from 'bullmq'
import env from '../config/env.js'

const connection = {
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
}

const emailQueue = new Queue('emailQueue', {
  connection,
  defaultJobOptions: {
    attempts: 3, // fail hone pe 3 baar try karo
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 10s, 20s
    },
    removeOnComplete: 50, // 50 completed jobs rakho
    removeOnFail: 100, // 100 failed jobs rakho
  },
})

// ─── JOB TYPES ───────────────────────────────────────────────
// Reusable — har jagah se call karo bas jobType change karo

const addEmailJob = (jobType, data) => {
  return emailQueue.add(jobType, data)
}

// ─── READY MADE HELPERS — BAR BAAR YAHI USE KARENGE ─────────

const sendWelcomeJob = (data) => addEmailJob('welcome', data)
// data: { to, name }

const sendDiscountJob = (data) => addEmailJob('discount', data)
// data: { to, name, courseTitle, originalPrice, discountPrice, token, expiresAt }

const sendInvoiceJob = (data) => addEmailJob('invoice', data)
// data: { to, name, courseTitle, amount, invoiceUrl, transactionId }

const sendSubAdminCredsJob = (data) => addEmailJob('subAdminCreds', data)
// data: { to, name, password }

export { sendWelcomeJob, sendDiscountJob, sendInvoiceJob, sendSubAdminCredsJob }
