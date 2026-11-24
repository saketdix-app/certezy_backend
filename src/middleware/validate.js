// src/middleware/validate.js

import {
  ACTIVITY_TYPES as LEAD_ACTIVITY_TYPES,
  FOLLOW_UP_TYPES,
  SOURCES as LEAD_SOURCES,
  STAGES as LEAD_STAGES,
  TICKET_CURRENCIES,
} from '../modules/crm/crm.constants.js'
import { STAFF_PERMISSIONS } from '../constants.js'
import Joi from 'joi'
import {
  LESSON_TYPES,
  COURSE_LEVELS,
  COURSE_STATUSES,
  PRICING_TYPES,
  TEST_TYPES,
  QUESTION_TYPES,
  DIFFICULTIES,
  ADMIN_REVIEW_SOURCES,
} from '../constants.js'

// "email must be a valid email" → "Enter a valid email address"
const friendlyMessage = (detail) => {
  if (!detail) return null
  const field = String(detail.context?.label ?? detail.path?.join('.') ?? '').replace(/_/g, ' ')
  if (detail.type === 'string.email') return 'Enter a valid email address'
  if (detail.type === 'any.required' || detail.type === 'string.empty') {
    return `${field.charAt(0).toUpperCase()}${field.slice(1)} is required`
  }
  // Custom messages (e.g. the password rule) are already readable
  return detail.message.replace(/['"]/g, '').replace(/^\w/, (c) => c.toUpperCase())
}

const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    })

    if (error) {
      const errors = error.details.map((d) => d.message.replace(/['"]/g, ''))
      // Say what's wrong (first problem) instead of a bare "Validation failed"
      const err = new Error(friendlyMessage(error.details[0]) || 'Please check the form and try again')
      err.statusCode = 422
      err.errors = errors
      return next(err)
    }

    req.body = value
    next()
  }
}

// Shared password rule (register, change password, sub-admin creation)
const strongPassword = Joi.string()
  .min(8)
  .max(72)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`])/)
  .messages({
    'string.pattern.base': 'Password must have uppercase, lowercase, number and special character',
  })

const registerSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().trim().email().max(150).lowercase().required(),
  password: strongPassword.required(),
})

const loginSchema = Joi.object({
  email: Joi.string().trim().email().lowercase().required(),
  password: Joi.string().required(),
})

const forgotPasswordSchema = Joi.object({
  email: Joi.string().trim().email().lowercase().required(),
})

const resetPasswordSchema = Joi.object({
  token: Joi.string().hex().length(64).required().messages({ '*': 'This reset link is invalid' }),
  password: strongPassword.required(),
})

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: strongPassword.required(),
})

// ── Categories ───────────────────────────────────────────────────────────

const createCategorySchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  slug: Joi.string().max(120).optional(),
  description: Joi.string().optional(),
  icon: Joi.string().max(255).optional(),
  parent_id: Joi.number().integer().optional(),
  sort_order: Joi.number().integer().default(0).optional(),
})

const updateCategorySchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  slug: Joi.string().max(120).optional(),
  description: Joi.string().optional(),
  icon: Joi.string().max(255).optional(),
  parent_id: Joi.number().integer().optional(),
  is_active: Joi.boolean().optional(),
  sort_order: Joi.number().integer().optional(),
})

// ── Courses ──────────────────────────────────────────────────────────────
const courseFields = {
  title: Joi.string().trim().min(3).max(200),
  slug: Joi.string().trim().max(220),
  description: Joi.string().allow(''),
  short_desc: Joi.string().max(500).allow(''),
  category_id: Joi.number().integer(),
  thumbnail: Joi.string().max(500).allow('', null),
  preview_video: Joi.string().max(500).allow('', null),
  pricing_type: Joi.string().valid(...PRICING_TYPES),
  price: Joi.number().min(0).precision(2),
  // List price shown struck-through; must be above `price` to count as a discount
  original_price: Joi.number().min(0).precision(2).allow(null),
  // India prices in rupees (empty → converted from USD)
  price_inr: Joi.number().min(0).precision(2).allow(null, ''),
  original_price_inr: Joi.number().min(0).precision(2).allow(null, ''),
  // Sell in rupees to visitors from India (off → everyone pays USD with PayPal)
  inr_enabled: Joi.boolean(),
  level: Joi.string().valid(...COURSE_LEVELS),
  language: Joi.string().max(50),
  status: Joi.string().valid(...COURSE_STATUSES),
  is_featured: Joi.boolean(),
  requirements: Joi.string().allow(''),
  what_you_learn: Joi.string().allow(''),
  certificate_eligible: Joi.number().integer().valid(0, 1),
  // Course page: exam & certification text, and FAQs (empty = section hidden)
  exam_info: Joi.string().max(20000).allow('', null),
  faqs: Joi.array()
    .items(Joi.object({ q: Joi.string().trim().min(3).max(300).required(), a: Joi.string().trim().min(1).max(3000).required() }))
    .max(40)
    .allow(null),
}

const createCourseSchema = Joi.object(courseFields).fork(['title', 'category_id'], (f) => f.required())
const updateCourseSchema = Joi.object(courseFields)

// ── Sections ─────────────────────────────────────────────────────────────
const createSectionSchema = Joi.object({
  course_id: Joi.number().integer().required(),
  title: Joi.string().min(2).max(200).required(),
  order_num: Joi.number().integer().optional(),
})

const updateSectionSchema = Joi.object({
  title: Joi.string().min(2).max(200).optional(),
  order_num: Joi.number().integer().optional(),
})

// ── Lessons ──────────────────────────────────────────────────────────────

const createLessonSchema = Joi.object({
  section_id: Joi.number().integer().required(),
  title: Joi.string().min(2).max(200).required(),
  type: Joi.string()
    .valid(...LESSON_TYPES)
    .optional(),
  content: Joi.string().allow('').optional(),
  duration: Joi.number().integer().optional(),
  order_num: Joi.number().integer().optional(),
  is_free: Joi.number().integer().valid(0, 1).optional(),
})

const updateLessonSchema = Joi.object({
  title: Joi.string().min(2).max(200).optional(),
  type: Joi.string()
    .valid(...LESSON_TYPES)
    .optional(),
  content: Joi.string().allow('').optional(),
  duration: Joi.number().integer().optional(),
  order_num: Joi.number().integer().optional(),
  is_free: Joi.number().integer().valid(0, 1).optional(),
})

// Tests
const createTestSchema = Joi.object({
  course_id: Joi.number().integer().required(),
  lesson_id: Joi.number().integer().optional(),
  title: Joi.string().min(2).max(200).required(),
  type: Joi.string()
    .valid(...TEST_TYPES)
    .optional(),
  duration: Joi.number().integer().optional(),
  pass_percentage: Joi.number().integer().min(1).max(100).optional(),
  status: Joi.string().valid('active', 'inactive').optional(),
})

const updateTestSchema = Joi.object({
  title: Joi.string().min(2).max(200).optional(),
  type: Joi.string()
    .valid(...TEST_TYPES)
    .optional(),
  duration: Joi.number().integer().optional(),
  pass_percentage: Joi.number().integer().min(1).max(100).optional(),
  status: Joi.string().valid('active', 'inactive').optional(),
})

// Questions
const createQuestionSchema = Joi.object({
  test_id: Joi.number().integer().required(),
  question: Joi.string().required(),
  type: Joi.string()
    .valid(...QUESTION_TYPES)
    .optional(),
  explanation: Joi.string().optional(),
  difficulty: Joi.string()
    .valid(...DIFFICULTIES)
    .optional(),
  topic_tag: Joi.string().max(100).optional(),
  order_num: Joi.number().integer().optional(),
})

const updateQuestionSchema = Joi.object({
  question: Joi.string().optional(),
  type: Joi.string()
    .valid(...QUESTION_TYPES)
    .optional(),
  explanation: Joi.string().optional(),
  difficulty: Joi.string()
    .valid(...DIFFICULTIES)
    .optional(),
  topic_tag: Joi.string().max(100).optional(),
  order_num: Joi.number().integer().optional(),
})

// Options
const createOptionSchema = Joi.object({
  question_id: Joi.number().integer().required(),
  option_text: Joi.string().required(),
  is_correct: Joi.number().integer().valid(0, 1).optional(),
  order_num: Joi.number().integer().optional(),
})

const bulkCreateOptionsSchema = Joi.object({
  question_id: Joi.number().integer().required(),
  options: Joi.array()
    .items(
      Joi.object({
        option_text: Joi.string().required(),
        is_correct: Joi.number().integer().valid(0, 1).optional(),
        order_num: Joi.number().integer().optional(),
      })
    )
    .min(2)
    .required(),
})

const updateOptionSchema = Joi.object({
  option_text: Joi.string().optional(),
  is_correct: Joi.number().integer().valid(0, 1).optional(),
  order_num: Joi.number().integer().optional(),
})

// ── Reviews ──────────────────────────────────────────────────────────────
const reviewSchema = Joi.object({
  course_id: Joi.number().integer().positive().required(),
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().max(1000).allow('', null).optional(),
})

const updateReviewSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().max(1000).allow('', null).optional(),
})

// Admin-entered review: a genuine review collected outside the site
// (classroom batch, corporate training, another platform, feedback form)
const adminReviewFields = {
  course_id: Joi.number().integer().positive(),
  reviewer_name: Joi.string().trim().min(2).max(100),
  rating: Joi.number().integer().min(1).max(5),
  comment: Joi.string().trim().max(2000).allow('', null),
  source: Joi.string().valid(...ADMIN_REVIEW_SOURCES),
  source_note: Joi.string().trim().max(255).allow('', null),
  reviewed_at: Joi.date().iso().max('now').allow(null, ''),
  is_approved: Joi.number().integer().valid(0, 1).default(1),
}
const createAdminReviewSchema = Joi.object({
  ...adminReviewFields,
  // The admin confirms this review really came from a learner
  confirm_genuine: Joi.boolean().valid(true).required().messages({
    'any.only': 'Please confirm this is a genuine review from a real learner',
    'any.required': 'Please confirm this is a genuine review from a real learner',
  }),
}).fork(['course_id', 'reviewer_name', 'rating', 'source'], (f) => f.required())
const updateAdminReviewSchema = Joi.object(adminReviewFields)

// ── CSV import ──────────────────────────────────────────────────────────
const csvImportSchema = Joi.object({
  csv: Joi.string()
    .min(1)
    .max(5 * 1024 * 1024)
    .required(), // raw CSV text (≤ 5 MB)
  dry_run: Joi.boolean().default(false),
  // courses only: create a category when the CSV names one that doesn't exist
  create_missing_categories: Joi.boolean().default(true),
  // reviews only: admin confirms every row is a genuine learner review
  confirm_genuine: Joi.boolean().default(false),
})

const createSubAdminSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().trim().email().max(150).lowercase().required(),
  password: strongPassword.required(),
  can_manage_courses: Joi.number().integer().valid(0, 1).optional(),
  can_manage_students: Joi.number().integer().valid(0, 1).optional(),
  can_send_discounts: Joi.number().integer().valid(0, 1).optional(),
  can_view_payments: Joi.number().integer().valid(0, 1).optional(),
  can_manage_tests: Joi.number().integer().valid(0, 1).optional(),
  can_assign_courses: Joi.number().integer().valid(0, 1).optional(),
  can_issue_certificates: Joi.number().integer().valid(0, 1).optional(),
})

// ── 2.0 Team (staff accounts) ────────────────────────────────────────────
const staffRole = Joi.string().valid('super_admin', 'admin', 'sub_admin', 'consultant', 'exam_coordinator')
const reauthPassword = Joi.string().max(72).allow('', null).optional()

const schemas = {
  register: registerSchema,
  createTeamMember: Joi.object({
    name: Joi.string().trim().min(2).max(100).required(),
    email: Joi.string().trim().email().max(150).lowercase().required(),
    mobile: Joi.string().trim().max(20).allow('', null).optional(),
    role: staffRole.required(),
    password: reauthPassword, // your own password, for Super Admin creation
    permissions: Joi.object(Object.fromEntries(STAFF_PERMISSIONS.map((k) => [k, Joi.boolean()]))).optional(),
  }),
  changeTeamRole: Joi.object({
    role: Joi.alternatives().try(staffRole, Joi.string().valid('student')).required(),
    password: reauthPassword,
  }),
  setTeamStatus: Joi.object({ is_active: Joi.boolean().required() }),
  updateTeamMember: Joi.object({
    name: Joi.string().trim().min(2).max(100).optional(),
    email: Joi.string().trim().email().max(150).lowercase().optional(),
    mobile: Joi.string().trim().max(20).allow('', null).optional(),
    password: reauthPassword, // your own password, when changing a sign-in email that needs it
  }).or('name', 'email', 'mobile'),
  // ── 2.0 CRM (leads) ──
  createLead: Joi.object({
    name: Joi.string().trim().min(2).max(150).required(),
    phone: Joi.string().trim().max(30).allow('', null).optional(),
    email: Joi.string().trim().email().max(150).lowercase().allow('', null).optional(),
    course_id: Joi.number().integer().positive().allow(null).optional(),
    preferred_schedule: Joi.string().trim().max(150).allow('', null).optional(),
    source: Joi.string().valid(...LEAD_SOURCES).default('manual'),
    source_meta: Joi.object({
      campaign: Joi.string().max(150).allow(''),
      ad: Joi.string().max(150).allow(''),
      form: Joi.string().max(150).allow(''),
      utm_source: Joi.string().max(150).allow(''),
      utm_medium: Joi.string().max(150).allow(''),
      utm_campaign: Joi.string().max(150).allow(''),
      referrer: Joi.string().max(150).allow(''),
    }).optional(),
    platform_lead_id: Joi.string().max(100).allow('', null).optional(),
    consent: Joi.object().optional(),
    owner_id: Joi.number().integer().positive().allow(null).optional(),
    auto_assign: Joi.boolean().optional(),
  }),
  updateLead: Joi.object({
    name: Joi.string().trim().min(2).max(150).optional(),
    phone: Joi.string().trim().max(30).allow('', null).optional(),
    email: Joi.string().trim().email().max(150).lowercase().allow('', null).optional(),
    course_id: Joi.number().integer().positive().allow(null).optional(),
    preferred_schedule: Joi.string().trim().max(150).allow('', null).optional(),
    ticket_size: Joi.number().positive().max(100000000).precision(2).allow(null).optional(),
    ticket_currency: Joi.string().valid(...TICKET_CURRENCIES).allow(null).optional(),
    // Added by the consultant; the phone from the lead source is kept as it is
    whatsapp_number: Joi.string().trim().pattern(/^[+\d][\d\s()-]{6,24}$/).allow('', null).optional()
      .messages({ 'string.pattern.base': 'Enter a valid WhatsApp number (with country code, e.g. +91 98765 43210)' }),
  }),
  messageTemplate: Joi.object({
    channel: Joi.string().valid('whatsapp', 'email').required(),
    title: Joi.string().trim().min(2).max(80).required(),
    subject: Joi.string().trim().max(150).allow('', null).optional(),
    body: Joi.string().trim().min(2).max(2000).required(),
    shared: Joi.boolean().optional(), // Admins: a template for the whole team
  }),
  appRelease: Joi.object({
    version: Joi.string().trim().pattern(/^\d+\.\d+\.\d+$/).required().messages({ 'string.pattern.base': 'Version like 1.3.0' }),
    version_code: Joi.number().integer().min(1).max(100000).required(),
    apk_url: Joi.string().trim().uri({ scheme: ['https'] }).max(250).required(),
    notes: Joi.string().trim().max(240).allow('', null).optional(),
  }),
  changeLeadStage: Joi.object({
    stage: Joi.string().valid(...LEAD_STAGES).required(),
    reason: Joi.string().trim().max(255).allow('', null).optional(),
    // required by the service when moving to Application
    ticket_size: Joi.number().positive().max(100000000).precision(2).optional(),
    ticket_currency: Joi.string().valid(...TICKET_CURRENCIES).optional(),
    // required when moving to Exam Scheduled (unless a date is already set)
    exam_scheduled_at: Joi.date().iso().optional(),
  }),
  leadApplication: Joi.object({
    submitted: Joi.boolean().required(),
    submitted_at: Joi.date().iso().max('now').allow(null).optional()
      .messages({ 'date.max': "The submission date can't be in the future" }),
  }),
  leadPayment: Joi.object({
    status: Joi.string().valid('due', 'done').required(),
    paid_at: Joi.date().iso().max('now').allow(null).optional()
      .messages({ 'date.max': "The payment date can't be in the future" }),
    reference: Joi.string().trim().max(255).allow('', null).optional(),
  }),
  leadExamCoordinator: Joi.object({
    exam_coordinator_id: Joi.number().integer().positive().allow(null).required(),
  }),
  leadExam: Joi.object({
    status: Joi.string().valid('not_scheduled', 'scheduled', 'rescheduled', 'cancelled').required(),
    scheduled_at: Joi.date().iso().allow(null).optional(),
    exam_done: Joi.boolean().optional(),
    completed_at: Joi.date().iso().max('now').allow(null).optional()
      .messages({ 'date.max': "The exam date can't be in the future once it's done" }),
    result: Joi.string().valid('passed', 'failed').allow(null).optional(),
    // Remark — required when cancelling (the service says so)
    note: Joi.string().trim().max(255).allow('', null).optional(),
  }),
  callSync: Joi.object({
    calls: Joi.array()
      .items(
        Joi.object({
          lead_id: Joi.number().integer().positive().required(),
          direction: Joi.string().valid('incoming', 'outgoing', 'missed', 'rejected').required(),
          at: Joi.date().iso().required(),
          duration_sec: Joi.number().integer().min(0).max(86400).default(0),
        })
      )
      .max(200)
      .required(),
  }),
  leadActivity: Joi.object({
    type: Joi.string().valid(...LEAD_ACTIVITY_TYPES).required(),
    body: Joi.string().trim().min(1).max(5000).required(),
    outcome: Joi.string().trim().max(100).allow('', null).optional(),
  }),
  scheduleFollowUp: Joi.object({
    due_at: Joi.date().iso().required(),
    type: Joi.string().valid(...FOLLOW_UP_TYPES).default('call'),
    note: Joi.string().trim().max(500).allow('', null).optional(),
  }),
  moveLeads: Joi.object({
    lead_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(2000).required(),
    // one owner, or several to split the leads evenly between
    owner_id: Joi.number().integer().positive(),
    owner_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(50).unique(),
    reason: Joi.string().trim().max(255).allow('', null).optional(),
    mode: Joi.string().valid('assign', 'rebalance').optional(),
  }).xor('owner_id', 'owner_ids'),
  distributionPool: Joi.object({
    name: Joi.string().trim().min(2).max(100).optional(),
    enabled: Joi.boolean().optional(),
    priority: Joi.number().integer().min(1).max(999).optional(),
    rules: Joi.object({
      course_ids: Joi.array().items(Joi.number().integer().positive()).max(100),
      sources: Joi.array().items(Joi.string().valid(...LEAD_SOURCES)).max(10),
      campaigns: Joi.array().items(Joi.string().trim().max(150)).max(50),
    }).optional(),
    member_ids: Joi.array().items(Joi.number().integer().positive()).max(500).optional(),
  }),
  roundRobinSetting: Joi.object({ round_robin_enabled: Joi.boolean().required() }),
  leadAssignCourse: Joi.object({
    course_id: Joi.number().integer().positive().allow(null).optional(),
    note: Joi.string().trim().max(255).allow('', null).optional(),
  }),
  leadDiscount: Joi.object({
    course_id: Joi.number().integer().positive().allow(null).optional(),
    discount_price: Joi.number().min(0).required(),
    discount_price_inr: Joi.number().min(1).allow(null, '').optional(),
    expiry_hours: Joi.number().integer().min(1).max(24 * 60).default(48),
  }),
  leadCertificate: Joi.object({
    course_id: Joi.number().integer().positive().allow(null).optional(),
    override_reason: Joi.string().trim().max(255).allow('', null).optional(),
  }),
  revokeDiscount: Joi.object({ reason: Joi.string().trim().min(2).max(255).required() }),
  crmSettings: Joi.object({ max_discount_pct: Joi.number().min(1).max(100).required() }),
  whatsappSend: Joi.object({
    text: Joi.string().trim().max(4096).allow('', null).optional(),
    template: Joi.string().trim().max(100).optional(),
    language: Joi.string().trim().max(20).optional(),
    params: Joi.array().items(Joi.string().max(500)).max(10).optional(),
  }).or('text', 'template'),
  automations: Joi.object({
    auto_stage_on_payment: Joi.boolean(),
    auto_course_done: Joi.boolean(),
    abandoned_checkout_nudge: Joi.boolean(),
    follow_up_reminders: Joi.boolean(),
  }).min(1),
  integrationSettings: Joi.object({
    enabled: Joi.boolean().optional(),
    config: Joi.object({
      // form id → course id, so each form's leads are interested in the right course
      form_courses: Joi.object().pattern(Joi.string().max(100), Joi.number().integer().positive()).optional(),
      default_course_id: Joi.number().integer().positive().allow(null).optional(),
      // Only these forms are imported; null / missing = every form, including new ones
      selected_forms: Joi.array().items(Joi.string().max(100)).max(2000).allow(null).optional(),
      // form id → name, shown on each lead
      form_names: Joi.object().pattern(Joi.string().max(100), Joi.string().max(300)).optional(),
    }).optional(),
  }),
  // Keys typed in Admin → Integrations: '' removes the portal value
  integrationCredentials: Joi.object({
    values: Joi.object().pattern(Joi.string().max(40), Joi.string().allow('').max(4000)).min(1).required(),
    password: Joi.string().max(200).required(),
  }),
  integrationConnect: Joi.object({ password: Joi.string().max(200).required() }),
  integrationOAuth: Joi.object({
    state: Joi.string().max(2000).required(),
    code: Joi.string().max(2000).optional(),
    error: Joi.string().max(200).optional(),
  }).or('code', 'error'),
  integrationOAuthChoose: Joi.object({
    selection: Joi.string().max(60000).required(),
    id: Joi.string().max(100).optional(),
    ids: Joi.array().items(Joi.string().max(100)).min(1).max(100).optional(),
  }).or('id', 'ids'),
  // Guest checkout (payments/guest/*)
  guestCheckout: Joi.object({
    course_id: Joi.number().integer().positive().required(),
    name: Joi.string().trim().min(2).max(150).required(),
    email: Joi.string().trim().email().max(150).lowercase().required(),
    phone: Joi.string().trim().pattern(/^[+\d][\d\s()-]{6,24}$/).allow('', null).optional()
      .messages({ 'string.pattern.base': 'Enter a valid phone number' }),
    consent: Joi.boolean().valid(true).required().messages({ 'any.only': 'Please accept the terms to continue' }),
  }),
  guestRazorpayVerify: Joi.object({
    guest_token: Joi.string().max(2000).required(),
    payment_id: Joi.number().integer().positive().required(),
    razorpay_order_id: Joi.string().max(100).required(),
    razorpay_payment_id: Joi.string().max(100).required(),
    razorpay_signature: Joi.string().max(200).required(),
  }),
  guestPaypalCapture: Joi.object({
    guest_token: Joi.string().max(2000).required(),
    payment_id: Joi.number().integer().positive().required(),
    paypal_order_id: Joi.string().max(100).required(),
  }),
  // Public course-page enquiry forms (enquiries module)
  // Upload leads from a CSV (check first with dry_run)
  leadImport: Joi.object({
    csv: Joi.string().max(50 * 1024 * 1024).required().messages({ 'string.max': 'The file is too big (50 MB max) — split it' }),
    dry_run: Joi.boolean().default(false),
    default_source: Joi.string().valid(...LEAD_SOURCES).default('manual'),
    course_id: Joi.number().integer().positive().allow(null, '').optional(),
    owner_mode: Joi.string().valid('me', 'unassigned', 'owner', 'round_robin', 'column').default('unassigned'),
    owner_id: Joi.number().integer().positive().allow(null, '').optional(),
    // Put every lead in the Backlog stage (worked in later by the consultant)
    as_backlog: Joi.boolean().default(false),
  }),
  deleteLeads: Joi.object({
    lead_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(2000).required(),
    password: Joi.string().max(72).required().messages({ 'any.required': 'Enter your password to confirm' }),
  }),
  // ── Two-step sign-in ──
  loginCode: Joi.object({
    challenge: Joi.string().trim().hex().length(48).required(),
    code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({ 'string.pattern.base': 'Enter the 6-digit code' }),
  }),
  loginChallenge: Joi.object({ challenge: Joi.string().trim().hex().length(48).required() }),
  // ── Team app push notifications ──
  pushDevice: Joi.object({
    token: Joi.string().trim().pattern(/^Expo(nent)?PushToken\[[^\]]+\]$/).max(200).required()
      .messages({ 'string.pattern.base': 'Not an Expo push token' }),
    platform: Joi.string().valid('android', 'ios').default('android'),
    device_name: Joi.string().trim().max(120).allow('', null).optional(),
  }),
  pushDeviceRemove: Joi.object({ token: Joi.string().trim().max(200).required() }),
  // ── Live batches ──
  liveBatch: Joi.object({
    title: Joi.string().trim().min(3).max(160).required(),
    course_id: Joi.number().integer().positive().allow(null).optional(),
    trainer_name: Joi.string().trim().max(120).allow('', null).optional(),
    trainer_title: Joi.string().trim().max(160).allow('', null).optional(),
    start_date: Joi.date().iso().required(),
    end_date: Joi.date().iso().allow(null, '').optional(),
    schedule: Joi.string().trim().max(160).allow('', null).optional(),
    timezone: Joi.string().trim().max(40).allow('', null).optional(),
    mode: Joi.string().valid('online', 'classroom', 'hybrid').default('online'),
    location: Joi.string().trim().max(160).allow('', null).optional(),
    seats: Joi.number().integer().min(1).max(100000).allow(null).optional(),
    price: Joi.number().min(0).max(100000000).allow(null).optional(),
    currency: Joi.string().valid('INR', 'USD').default('INR'),
    description: Joi.string().trim().max(2000).allow('', null).optional(),
    status: Joi.string().valid('draft', 'published', 'closed', 'cancelled').default('draft'),
  }),
  liveBatchUpdate: Joi.object({
    title: Joi.string().trim().min(3).max(160),
    course_id: Joi.number().integer().positive().allow(null),
    trainer_name: Joi.string().trim().max(120).allow('', null),
    trainer_title: Joi.string().trim().max(160).allow('', null),
    start_date: Joi.date().iso(),
    end_date: Joi.date().iso().allow(null, ''),
    schedule: Joi.string().trim().max(160).allow('', null),
    timezone: Joi.string().trim().max(40).allow('', null),
    mode: Joi.string().valid('online', 'classroom', 'hybrid'),
    location: Joi.string().trim().max(160).allow('', null),
    seats: Joi.number().integer().min(1).max(100000).allow(null),
    price: Joi.number().min(0).max(100000000).allow(null),
    currency: Joi.string().valid('INR', 'USD'),
    description: Joi.string().trim().max(2000).allow('', null),
    status: Joi.string().valid('draft', 'published', 'closed', 'cancelled'),
  }).min(1),
  batchEnroll: Joi.object({
    name: Joi.string().trim().min(2).max(150).required(),
    email: Joi.string().trim().email().max(150).lowercase().required(),
    phone: Joi.string().trim().pattern(/^[+\d][\d\s()-]{6,24}$/).required()
      .messages({ 'string.pattern.base': 'Enter a valid phone number' }),
    company: Joi.string().trim().max(150).allow('', null).optional(),
    experience_years: Joi.number().integer().min(0).max(60).allow(null).optional(),
    message: Joi.string().trim().max(1000).allow('', null).optional(),
    consent: Joi.boolean().valid(true).required().messages({ 'any.only': 'Please agree to be contacted' }),
    website: Joi.string().allow('').max(200).optional(), // honeypot
  }),
  enquiry: Joi.object({
    kind: Joi.string().valid('advisor', 'syllabus', 'team').required(),
    course_id: Joi.number().integer().positive().allow(null).optional(),
    name: Joi.string().trim().min(2).max(150).required(),
    email: Joi.string().trim().email().max(150).lowercase().allow('', null).optional(),
    phone: Joi.string().trim().pattern(/^[+\d][\d\s()-]{6,24}$/).allow('', null).optional()
      .messages({ 'string.pattern.base': 'Enter a valid phone number' }),
    company: Joi.string().trim().max(150).allow('', null).optional(),
    team_size: Joi.number().integer().min(2).max(100000).allow(null).optional(),
    preferred_time: Joi.string().trim().max(60).allow('', null).optional(),
    message: Joi.string().trim().max(1000).allow('', null).optional(),
    consent: Joi.boolean().valid(true).required().messages({ 'any.only': 'Please agree to be contacted' }),
    website: Joi.string().allow('').max(200).optional(), // honeypot: real people never see or fill it
  }),
  completeFollowUp: Joi.object({
    status: Joi.string().valid('done', 'missed', 'cancelled').required(),
    outcome: Joi.string().trim().max(500).allow('', null).optional(),
  }),
  teamPermissions: Joi.object(
    Object.fromEntries(STAFF_PERMISSIONS.map((k) => [k, Joi.boolean().required()]))
  ),
  consultantAllocation: Joi.object({
    accepting_leads: Joi.boolean().required(),
    paused_reason: Joi.string().trim().max(255).allow('', null).optional(),
    on_leave_from: Joi.date().iso().allow(null).optional(),
    on_leave_until: Joi.date().iso().allow(null).optional(),
    daily_limit: Joi.number().integer().min(0).max(10000).allow(null).optional(),
    open_limit: Joi.number().integer().min(0).max(100000).allow(null).optional(),
  }),
  reauth: Joi.object({ password: reauthPassword }),
  // What happens to someone's leads when they leave, are blocked or change role
  teamHandover: Joi.object({
    owner_mode: Joi.string().valid('owner', 'round_robin', 'unassigned', 'keep').default('keep'),
    owner_id: Joi.number().integer().positive().when('owner_mode', { is: 'owner', then: Joi.required(), otherwise: Joi.forbidden() }),
    coordinator_mode: Joi.string().valid('coordinator', 'unassigned', 'keep').default('keep'),
    coordinator_id: Joi.number().integer().positive().when('coordinator_mode', { is: 'coordinator', then: Joi.required(), otherwise: Joi.forbidden() }),
  }),
  teamDelete: Joi.object({
    confirm_email: Joi.string().trim().lowercase().email().required(),
    handover: Joi.object().unknown(true).optional(),
  }),
  createSubAdmin: createSubAdminSchema,
  assignCourses: Joi.object({
    user_id: Joi.number().integer().positive().required(),
    course_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(50).required(),
    note: Joi.string().trim().max(255).allow('', null).optional(),
  }),
  generatePresignedUrl: Joi.object({
    fileName: Joi.string().required().max(255),
    fileType: Joi.string().required().max(100),
    fileSize: Joi.number().integer().min(1).optional(),
    kind: Joi.string().valid('image', 'video', 'document', 'avatar').optional(),
    isPublic: Joi.boolean().optional().default(true),
  }),
  login: loginSchema,
  createReview: reviewSchema,
  updateReview: updateReviewSchema,
  createAdminReview: createAdminReviewSchema,
  updateAdminReview: updateAdminReviewSchema,
  csvImport: csvImportSchema,
  changePassword: changePasswordSchema,
  forgotPassword: forgotPasswordSchema,
  resetPassword: resetPasswordSchema,
  createCategory: createCategorySchema,
  updateCategory: updateCategorySchema,
  createCourse: createCourseSchema,
  updateCourse: updateCourseSchema,
  createSection: createSectionSchema,
  updateSection: updateSectionSchema,
  createLesson: createLessonSchema,
  updateLesson: updateLessonSchema,
  createTest: createTestSchema,
  updateTest: updateTestSchema,
  createQuestion: createQuestionSchema,
  updateQuestion: updateQuestionSchema,
  createOption: createOptionSchema,
  bulkCreateOptions: bulkCreateOptionsSchema,
  updateOption: updateOptionSchema,
}

export { validate, schemas }
