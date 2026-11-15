// src/jobs/leadIngestWorker.js
// Processes integration lead events, and syncs LinkedIn every 10 minutes.

import { Worker } from 'bullmq'
import { connection, enqueueIngest } from './leadIngestQueue.js'
import { processEvent, syncLinkedIn } from '../modules/integrations/ingest.service.js'

const worker = new Worker('leadIngest', async (job) => processEvent(job.data.eventId), { connection, concurrency: 3 })

worker.on('failed', (job, err) =>
  console.error(`Lead ingest ${job?.data?.eventId} failed (attempt ${job?.attemptsMade}):`, err.message)
)

// LinkedIn Lead Sync: every 10 minutes while the integration is switched on
// (keys may be saved in the admin portal at any time, so always schedule)
const LINKEDIN_EVERY_MS = 10 * 60 * 1000
setInterval(() => syncLinkedIn(enqueueIngest).catch(() => {}), LINKEDIN_EVERY_MS).unref()

export default worker
