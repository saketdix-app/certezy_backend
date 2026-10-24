// src/modules/certificates/certificates.routes.js

import { Router } from 'express'
import * as controller from './certificates.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'

const router = Router()

// ─── STUDENT ──────────────────────────────────────────────────
router.get('/', authenticate, role('student'), controller.getMyCertificates)

// ─── ADMIN ────────────────────────────────────────────────────
router.post('/issue', authenticate, role('admin', 'sub_admin'), controller.adminIssueCertificate)
router.get('/admin/all', authenticate, role('admin', 'sub_admin'), controller.getAllCertificates)

export default router
