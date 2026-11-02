// src/modules/upload/upload.routes.js

import { Router } from 'express'
import * as controller from './upload.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── ADMIN / SUB-ADMIN ONLY ───────────────────────────────────
// This issues a temporary pre-signed URL allowing frontend to securely upload direct to S3
router.post(
  '/presigned-url',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.generatePresignedUrl),
  controller.getPresignedUrl
)

// Any signed-in user: pre-signed URL for their own profile photo (avatar kind only)
router.post(
  '/avatar-url',
  authenticate,
  validate(schemas.generatePresignedUrl),
  (req, res, next) => {
    req.body.kind = 'avatar'
    req.body.isPublic = true
    next()
  },
  controller.getPresignedUrl
)

// Storage health + upload limits (admin only)
router.get('/status', authenticate, role('admin', 'sub_admin'), controller.getStatus)

export default router
