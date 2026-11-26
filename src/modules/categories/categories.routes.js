// src/modules/categories/categories.routes.js

import { Router } from 'express'
import * as controller from './categories.controller.js'
import authenticate from '../../middleware/auth.js'

import role from '../../middleware/role.js'
import permission from '../../middleware/permission.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── PUBLIC ──────────────────────────────────────────────────
router.get('/', controller.getAllCategories)
router.get('/slug/:slug', controller.getCategoryBySlug)
router.get('/:id', controller.getCategoryById)

// ─── ADMIN, or SUB-ADMIN with "Create and edit categories" (delete: Admins) ───
router.post(
  '/create',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_categories'),
  validate(schemas.createCategory),
  controller.createCategory
)
router.put(
  '/update/:id',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_categories'),
  validate(schemas.updateCategory),
  controller.updateCategory
)
router.delete('/delete/:id', authenticate, role('admin'), controller.deleteCategory)

export default router
