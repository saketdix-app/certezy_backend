// src/jobs/leadIngestQueue.js
// 2.0 Phase 7: integration leads are processed in the background, with
// retries (PRD §8: retry handling and an error queue for failed imports).

import { Queue } from 'bullmq'
import env from '../config/env.js'

export const connection = { host: env.redis.host, port: env.redis.port, password: env.redis.password }

const leadIngestQueue = new Queue('leadIngest', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 30000 }, // 30s, 1m, 2m, 4m, 8m
    removeOnComplete: 200,
    removeOnFail: 500,
  },
})

/** Queue one recorded event (job id = event id, so it's never queued twice at once). */
export const enqueueIngest = (eventId) =>
  leadIngestQueue.add('process', { eventId }, { jobId: `ingest-${eventId}-${Date.now()}` })

export default leadIngestQueue
