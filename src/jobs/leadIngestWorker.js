// src/jobs/leadIngestWorker.js
// Processes integration lead events, and syncs LinkedIn every 10 minutes.

import { Worker } from 'bullmq'
import { connection, enqueueIngest } from './leadIngestQueue.js'
import { processEvent, syncLinkedIn } from '../modules/integrations/ingest.service.js'
import { renewLinkedIn } from '../modules/integrations/oauth.js'

const worker = new Worker('leadIngest', async (job) => processEvent(job.data.eventId), { connection, concurrency: 3 })

worker.on('failed', (job, err) =>
  console.error(`Lead ingest ${job?.data?.eventId} failed (attempt ${job?.attemptsMade}):`, err.message)
)

// LinkedIn Lead Sync: every 10 minutes while the integration is switched on
// (keys may be saved in the admin portal at any time, so always schedule)
const LINKEDIN_EVERY_MS = 10 * 60 * 1000
setInterval(() => syncLinkedIn(enqueueIngest).catch(() => {}), LINKEDIN_EVERY_MS).unref()

// LinkedIn tokens from "Connect with LinkedIn" last ~60 days: renew in their last week
const renew = () => renewLinkedIn().catch((err) => console.error('LinkedIn renewal check failed:', err.message))
setTimeout(renew, 60 * 1000).unref()
setInterval(renew, 6 * 60 * 60 * 1000).unref()

export default worker
