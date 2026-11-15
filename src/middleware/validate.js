// src/middleware/validate.js

import {
  ACTIVITY_TYPES as LEAD_ACTIVITY_TYPES,
  FOLLOW_UP_TYPES,
  SOURCES as LEAD_SOURCES,
  STAGES as LEAD_STAGES,
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
const staffRole = Joi.string().valid('super_admin', 'admin', 'sub_admin', 'consultant')
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
  }),
  changeLeadStage: Joi.object({
    stage: Joi.string().valid(...LEAD_STAGES).required(),
    reason: Joi.string().trim().max(255).allow('', null).optional(),
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
    lead_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(500).required(),
    owner_id: Joi.number().integer().positive().required(),
    reason: Joi.string().trim().max(255).allow('', null).optional(),
    mode: Joi.string().valid('assign', 'rebalance').optional(),
  }),
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
    on_leave_until: Joi.date().iso().allow(null).optional(),
    daily_limit: Joi.number().integer().min(0).max(10000).allow(null).optional(),
    open_limit: Joi.number().integer().min(0).max(100000).allow(null).optional(),
  }),
  reauth: Joi.object({ password: reauthPassword }),
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
