// src/middleware/validate.js

import Joi from 'joi'

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

const registerSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().max(150).lowercase().required(),
  password: Joi.string()
    .min(8)
    .max(72)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`])/)
    .required()
    .messages({
      'string.pattern.base': 'Password must have uppercase, lowercase, number and special character',
    }),
})

const loginSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  password: Joi.string().required(),
})

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string()
    .min(8)
    .max(72)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`])/)
    .required()
    .messages({
      'string.pattern.base': 'Password must have uppercase, lowercase, number and special character',
    }),
})

// category relted scema

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

// courses related scemas
const createCourseSchema = Joi.object({
  title: Joi.string().min(3).max(200).required(),
  slug: Joi.string().max(220).optional(),
  description: Joi.string().optional(),
  short_desc: Joi.string().max(500).optional(),
  category_id: Joi.number().integer().required(),
  thumbnail: Joi.string().max(500).optional(),
  preview_video: Joi.string().max(500).optional(),
  price: Joi.number().min(0).optional(),
  level: Joi.string().valid('beginner', 'intermediate', 'advanced').optional(),
  language: Joi.string().max(50).optional(),
  status: Joi.string().valid('draft', 'published', 'archived').optional(),
  is_featured: Joi.boolean().optional(),
  requirements: Joi.string().optional(),
  what_you_learn: Joi.string().optional(),
  certificate_eligible: Joi.number().integer().valid(0, 1).optional(),
})

const updateCourseSchema = Joi.object({
  title: Joi.string().min(3).max(200).optional(),
  slug: Joi.string().max(220).optional(),
  description: Joi.string().optional(),
  short_desc: Joi.string().max(500).optional(),
  category_id: Joi.number().integer().optional(),
  thumbnail: Joi.string().max(500).optional(),
  preview_video: Joi.string().max(500).optional(),
  price: Joi.number().min(0).optional(),
  level: Joi.string().valid('beginner', 'intermediate', 'advanced').optional(),
  language: Joi.string().max(50).optional(),
  status: Joi.string().valid('draft', 'published', 'archived').optional(),
  is_featured: Joi.boolean().optional(),
  requirements: Joi.string().optional(),
  what_you_learn: Joi.string().optional(),
  certificate_eligible: Joi.number().integer().valid(0, 1).optional(),
})

//section releted schemas
const createSectionSchema = Joi.object({
  course_id: Joi.number().integer().required(),
  title: Joi.string().min(2).max(200).required(),
  order_num: Joi.number().integer().optional(),
})

const updateSectionSchema = Joi.object({
  title: Joi.string().min(2).max(200).optional(),
  order_num: Joi.number().integer().optional(),
})

// lessson related scema

const createLessonSchema = Joi.object({
  section_id: Joi.number().integer().required(),
  title: Joi.string().min(2).max(200).required(),
  type: Joi.string().valid('video', 'article', 'quiz').optional(),
  content: Joi.string().optional(),
  duration: Joi.number().integer().optional(),
  order_num: Joi.number().integer().optional(),
  is_free: Joi.number().integer().valid(0, 1).optional(),
})

const updateLessonSchema = Joi.object({
  title: Joi.string().min(2).max(200).optional(),
  type: Joi.string().valid('video', 'article', 'quiz').optional(),
  content: Joi.string().optional(),
  duration: Joi.number().integer().optional(),
  order_num: Joi.number().integer().optional(),
  is_free: Joi.number().integer().valid(0, 1).optional(),
})

// Tests
const createTestSchema = Joi.object({
  course_id: Joi.number().integer().required(),
  lesson_id: Joi.number().integer().optional(),
  title: Joi.string().min(2).max(200).required(),
  type: Joi.string().valid('practice', 'mock', 'diagnostic', 'final').optional(),
  duration: Joi.number().integer().optional(),
  pass_percentage: Joi.number().integer().min(1).max(100).optional(),
  status: Joi.string().valid('active', 'inactive').optional(),
})

const updateTestSchema = Joi.object({
  title: Joi.string().min(2).max(200).optional(),
  type: Joi.string().valid('practice', 'mock', 'diagnostic', 'final').optional(),
  duration: Joi.number().integer().optional(),
  pass_percentage: Joi.number().integer().min(1).max(100).optional(),
  status: Joi.string().valid('active', 'inactive').optional(),
})

// Questions
const createQuestionSchema = Joi.object({
  test_id: Joi.number().integer().required(),
  question: Joi.string().required(),
  type: Joi.string().valid('single', 'multiple', 'true_false').optional(),
  explanation: Joi.string().optional(),
  difficulty: Joi.string().valid('easy', 'medium', 'hard').optional(),
  topic_tag: Joi.string().max(100).optional(),
  order_num: Joi.number().integer().optional(),
})

const updateQuestionSchema = Joi.object({
  question: Joi.string().optional(),
  type: Joi.string().valid('single', 'multiple', 'true_false').optional(),
  explanation: Joi.string().optional(),
  difficulty: Joi.string().valid('easy', 'medium', 'hard').optional(),
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

const createSubAdminSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().max(150).lowercase().required(),
  password: Joi.string()
    .min(8)
    .max(72)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`])/)
    .required()
    .messages({
      'string.pattern.base': 'Password must have uppercase, lowercase, number and special character',
    }),
  can_manage_courses: Joi.number().integer().valid(0, 1).optional(),
  can_manage_students: Joi.number().integer().valid(0, 1).optional(),
  can_send_discounts: Joi.number().integer().valid(0, 1).optional(),
  can_view_payments: Joi.number().integer().valid(0, 1).optional(),
  can_manage_tests: Joi.number().integer().valid(0, 1).optional(),
})

const schemas = {
  register: registerSchema,
  createSubAdmin: createSubAdminSchema,
  generatePresignedUrl: Joi.object({
    fileName: Joi.string().required().max(200),
    fileType: Joi.string().required().max(50),
    isPublic: Joi.boolean().optional().default(true),
  }),
  login: loginSchema,
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
