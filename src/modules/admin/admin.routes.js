// src/modules/admin/admin.routes.js

import { Router } from 'express'
import * as controller from './admin.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── DASHBOARD & STATS ─────────────────────────────────────────
router.get('/dashboard', authenticate, role('admin', 'sub_admin'), controller.getDashboardStats)
router.get('/stats', authenticate, role('admin', 'sub_admin'), controller.getDashboardStats)

// ─── ADMIN ONLY ───────────────────────────────────────────────
router.get('/permissions/:userId', authenticate, role('admin'), controller.getPermissions)
router.post('/permissions', authenticate, role('admin'), controller.createPermissions)
router.put('/permissions/:userId', authenticate, role('admin'), controller.updatePermissions)
router.delete('/permissions/:userId', authenticate, role('admin'), controller.deletePermissions)

router.post(
  '/sub-admins/create',
  authenticate,
  role('admin'),
  validate(schemas.createSubAdmin),
  controller.createSubAdmin
)

export default router
