// src/modules/certificates/certificates.routes.js

import { Router } from 'express'
import * as controller from './certificates.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { LEARNER_ROLES } from '../../constants.js'

const router = Router()

// ─── PUBLIC ───────────────────────────────────────────────────
router.get('/verify/:certificateNo', controller.verifyCertificate)

// ─── STUDENT ──────────────────────────────────────────────────
router.get('/', authenticate, role(...LEARNER_ROLES), controller.getMyCertificates)
router.post('/claim/:courseId', authenticate, role(...LEARNER_ROLES), controller.claimCertificate)

// ─── ADMIN ────────────────────────────────────────────────────
router.post('/issue', authenticate, role('admin', 'sub_admin'), controller.adminIssueCertificate)
router.get('/admin/all', authenticate, role('admin', 'sub_admin'), controller.getAllCertificates)
router.delete('/:id', authenticate, role('admin'), controller.revokeCertificate)

export default router
