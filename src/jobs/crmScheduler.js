// src/jobs/crmScheduler.js
// 2.0 Phase 8: runs the timed CRM automations every 5 minutes.

import { runAbandonedCheckout, runFollowUpReminders } from '../modules/crm/automation.service.js'
import { markExamsTaken } from '../modules/crm/leads.service.js'

const EVERY_MS = 5 * 60 * 1000

const tick = async () => {
  try {
    await runFollowUpReminders()
    await runAbandonedCheckout()
    await markExamsTaken() // exam time passed → Exam done (payment-due alert)
  } catch (err) {
    console.error('CRM scheduler failed:', err.message)
  }
}

setTimeout(tick, 30 * 1000).unref() // shortly after start-up
setInterval(tick, EVERY_MS).unref()
