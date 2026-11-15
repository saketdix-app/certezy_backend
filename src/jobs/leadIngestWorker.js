// src/jobs/leadIngestWorker.js
// Processes integration lead events, and syncs LinkedIn every 10 minutes.

import { Worker } from 'bullmq'
import env from '../config/env.js'
import { connection, enqueueIngest } from './leadIngestQueue.js'
import { processEvent, syncLinkedIn } from '../modules/integrations/ingest.service.js'

const worker = new Worker('leadIngest', async (job) => processEvent(job.data.eventId), { connection, concurrency: 3 })

worker.on('failed', (job, err) =>
  console.error(`Lead ingest ${job?.data?.eventId} failed (attempt ${job?.attemptsMade}):`, err.message)
)

// LinkedIn Lead Sync: poll every 10 minutes when credentials are present
const LINKEDIN_EVERY_MS = 10 * 60 * 1000
if (env.integrations.linkedin.accessToken && env.integrations.linkedin.adAccountId) {
  setInterval(() => syncLinkedIn(enqueueIngest).catch(() => {}), LINKEDIN_EVERY_MS).unref()
}

export default worker
