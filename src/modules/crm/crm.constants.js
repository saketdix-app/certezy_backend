// src/modules/crm/crm.constants.js
// 2.0 Phase 3 — lead pipeline definitions (PRD §4.2, §5).

// The eight stages, in pipeline order
export const STAGES = [
  'new',
  'attempting_contact',
  'in_conversation',
  'on_hold',
  'application',
  'course_done',
  'not_interested',
  'junk',
]

export const STAGE_LABELS = {
  new: 'New Leads',
  attempting_contact: 'Attempting Contact',
  in_conversation: 'In Conversation',
  on_hold: 'On Hold',
  application: 'Application',
  course_done: 'Course Done',
  not_interested: 'Not Interested',
  junk: 'Junk Lead',
}

// Allowed next stages (PRD §4.2). Closed stages reopen only with a reason,
// by an Admin or Super Admin.
export const TRANSITIONS = {
  new: ['attempting_contact', 'junk'],
  attempting_contact: ['in_conversation', 'on_hold', 'not_interested', 'junk'],
  in_conversation: ['on_hold', 'application', 'not_interested'],
  on_hold: ['attempting_contact', 'in_conversation', 'not_interested'],
  application: ['course_done', 'on_hold', 'not_interested'],
  course_done: [],
  not_interested: ['attempting_contact', 'in_conversation'], // reopen
  junk: ['new', 'attempting_contact'], // reopen
}

export const CLOSED_STAGES = ['not_interested', 'junk']
// Stages that need a recorded reason to enter
export const REASON_REQUIRED = ['not_interested', 'junk', 'on_hold']

export const SOURCES = ['meta', 'linkedin', 'website', 'referral', 'whatsapp', 'manual', 'other']

export const ACTIVITY_TYPES = ['note', 'call', 'message', 'email', 'whatsapp']

export const FOLLOW_UP_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'demo', 'other']
export const FOLLOW_UP_STATUSES = ['pending', 'done', 'missed', 'cancelled']

// Enrollment status of the linked student, kept apart from the pipeline stage
// and from course completion (PRD §4.2 terminology note).
export const ENROLLMENT_STATUSES = ['none', 'application', 'payment_pending', 'enrolled']
