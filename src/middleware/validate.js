// src/middleware/validate.js

import Joi from 'joi'
import {
  LESSON_TYPES,
  COURSE_LEVELS,
  COURSE_STATUSES,
  PRICING_TYPES,
  TEST_TYPES,
  QUESTION_TYPES,
  DIFFICULTIES,
} from '../constants.js'

const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    })

    if (error) {
      const err = new Error('Validation failed')
      err.statusCode = 422
      err.errors = error.details.map((d) => d.message.replace(/['"]/g, ''))
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
  email: Joi.string().email().max(150).lowercase().required(),
  password: strongPassword.required(),
})

const loginSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  password: Joi.string().required(),
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

// ── CSV import ──────────────────────────────────────────────────────────
const csvImportSchema = Joi.object({
  csv: Joi.string()
    .min(1)
    .max(5 * 1024 * 1024)
    .required(), // raw CSV text (≤ 5 MB)
  dry_run: Joi.boolean().default(false),
  // courses only: create a category when the CSV names one that doesn't exist
  create_missing_categories: Joi.boolean().default(true),
})

const createSubAdminSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().max(150).lowercase().required(),
  password: strongPassword.required(),
  can_manage_courses: Joi.number().integer().valid(0, 1).optional(),
  can_manage_students: Joi.number().integer().valid(0, 1).optional(),
  can_send_discounts: Joi.number().integer().valid(0, 1).optional(),
  can_view_payments: Joi.number().integer().valid(0, 1).optional(),
  can_manage_tests: Joi.number().integer().valid(0, 1).optional(),
})

const schemas = {
  register: registerSchema,
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
    kind: Joi.string().valid('image', 'video', 'document').optional(),
    isPublic: Joi.boolean().optional().default(true),
  }),
  login: loginSchema,
  createReview: reviewSchema,
  updateReview: updateReviewSchema,
  csvImport: csvImportSchema,
  changePassword: changePasswordSchema,
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
