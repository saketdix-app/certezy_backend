// src/jobs/emailWorker.js

import { Worker } from 'bullmq'
import env from '../config/env.js'
import { sendWelcomeMail, sendDiscountMail, sendInvoiceMail, sendSubAdminCredsMail } from '../utils/mailer.js'

const connection = {
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
}

const worker = new Worker(
  'emailQueue',
  async (job) => {
    const { name, data } = job

    // jobType ke hisaab se sahi mail bhejo
    switch (name) {
      case 'welcome':
        await sendWelcomeMail(data.to, data.name)
        break

      case 'discount':
        await sendDiscountMail(data.to, data)
        break

      case 'invoice':
        await sendInvoiceMail(data.to, data)
        break

      case 'subAdminCreds':
        await sendSubAdminCredsMail(data.to, data)
        break

      default:
        throw new Error(`Unknown email job type: ${name}`)
    }
  },
  {
    connection,
    concurrency: 5, // ek saath 5 emails process karo
  }
)

worker.on('completed', (job) => {
  console.log(`✅ Email sent — job: ${job.name} id: ${job.id}`)
})

worker.on('failed', (job, err) => {
  console.error(`❌ Email failed — job: ${job.name} id: ${job.id}`, err.message)
})

export default worker
