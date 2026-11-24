// src/modules/crm/crm.constants.js
// 2.0 Phase 3 — lead pipeline definitions (PRD §4.2, §5).

// The stages, in the order the tabs show them (web and app)
export const STAGES = [
  // Uploaded in bulk; the consultant works them in when they have time
  'backlog',
  'new',
  'attempting_contact',
  'in_conversation',
  'application',
  'exam_scheduled',
  'course_done',
  'no_response',
  'on_hold',
  'not_interested',
  'junk',
]

export const STAGE_LABELS = {
  backlog: 'Backlog',
  new: 'New Leads',
  attempting_contact: 'Attempting Contact',
  in_conversation: 'In Conversation',
  application: 'Application',
  exam_scheduled: 'Exam Scheduled',
  course_done: 'Course Done',
  no_response: 'No Response',
  on_hold: 'On Hold',
  not_interested: 'Not Interested',
  junk: 'Junk Lead',
}

// A lead can move to any other stage, forwards or backwards, including
// reopening a closed one (with a reason). The one exception: Course Done is
// never chosen by hand — the lead moves there automatically when its Payment
// Status is set to Payment Done (a sale is counted then). Every move is
// recorded in the lead's history: from, to, who and when.
export const TRANSITIONS = Object.fromEntries(
  STAGES.map((from) => [from, STAGES.filter((to) => to !== from && to !== 'course_done')])
)

export const CLOSED_STAGES = ['not_interested', 'junk']

// Ticket size (expected deal value) recorded when a lead moves to Application
export const TICKET_CURRENCIES = ['INR', 'USD']

// Exam on a lead, worked by its Exam Coordinator (or anyone with access).
// exam_status is the schedule; exam_done turns on by itself once the exam time has passed.
export const EXAM_STATUSES = ['not_scheduled', 'scheduled', 'rescheduled', 'cancelled']
export const EXAM_RESULTS = ['passed', 'failed']
// Payment Due (default) → Payment Done, which moves the lead to Course Done
export const PAYMENT_STATUSES = ['due', 'done']
// Stages where marking Payment Done moves the lead to Course Done
export const PAYMENT_TO_COURSE_DONE = ['application', 'exam_scheduled', 'on_hold', 'in_conversation', 'no_response']
// Stages that need a recorded reason to enter
export const REASON_REQUIRED = ['not_interested', 'junk', 'on_hold']

export const SOURCES = ['meta', 'linkedin', 'website', 'referral', 'whatsapp', 'manual', 'other']

export const ACTIVITY_TYPES = ['note', 'call', 'message', 'email', 'whatsapp']
/** Timeline entries that are a conversation with (or about) the client. */
export const DISCUSSION_TYPES = [...ACTIVITY_TYPES, 'whatsapp_in', 'whatsapp_api', 'follow_up_done']
/** Open = still being worked (not Course Done, not closed). */
export const OPEN_STAGES_SQL = "l.stage NOT IN ('course_done', 'not_interested', 'junk')"

export const FOLLOW_UP_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'demo', 'other']
export const FOLLOW_UP_STATUSES = ['pending', 'done', 'missed', 'cancelled']

// Sale attribution (PRD §10.3, decided): a sale counts for the consultant who
// owns the lead when the payment is confirmed — not the original owner.
export const SALE_ATTRIBUTION = 'owner_at_sale'

// How a lead got its owner (lead_activities 'assignment' meta.how)
export const ASSIGNMENT_HOW = ['on_create', 'round_robin', 'manual', 'transfer', 'rebalance']

// Lead fields a distribution pool can route on (PRD §6.3 pool rules)
export const POOL_RULE_KEYS = ['course_ids', 'sources', 'campaigns']

// Enrollment status of the linked student, kept apart from the pipeline stage
// and from course completion (PRD §4.2 terminology note).
export const ENROLLMENT_STATUSES = ['none', 'application', 'payment_pending', 'enrolled']
