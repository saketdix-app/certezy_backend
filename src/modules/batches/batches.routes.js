// src/modules/batches/batches.routes.js
// Public:  GET  /api/v1/batches            upcoming published live batches
//          POST /api/v1/batches/:id/enroll enrollment (rate-limited) → CRM lead
// Admin:   GET/POST /api/v1/batches/admin, PUT/DELETE /admin/:id, GET /admin/:id/enrollments

import { Router } from 'express'
import authenticate from '../../middleware/auth.js'
import { allow } from '../../utils/access.js'
import { validate, schemas } from '../../middleware/validate.js'
import { enquiryLimiter } from '../../middleware/rateLimit.js'
import { success } from '../../utils/response.js'
import * as service from './batches.service.js'

const router = Router()
// Admins and Super Admins, and Sub-Admins with "Live batches" (Team → Permissions)
const admins = [authenticate, allow('can_manage_batches')]
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res)
  } catch (err) {
    next(err)
  }
}

router.get('/admin', ...admins, handle(async (req, res) => success(res, { data: await service.listBatches() })))
router.post('/admin', ...admins, validate(schemas.liveBatch), handle(async (req, res) =>
  success(res, { message: 'Batch saved', statusCode: 201, data: await service.createBatch(req, req.body) })))
router.put('/admin/:id', ...admins, validate(schemas.liveBatchUpdate), handle(async (req, res) =>
  success(res, { message: 'Batch updated', data: await service.updateBatch(req, req.params.id, req.body) })))
router.delete('/admin/:id', ...admins, handle(async (req, res) =>
  success(res, { message: 'Batch deleted', data: await service.deleteBatch(req, req.params.id) })))
router.get('/admin/:id/enrollments', ...admins, handle(async (req, res) =>
  success(res, { data: await service.batchEnrollments(req.params.id) })))

router.get('/', handle(async (req, res) => success(res, { data: await service.upcomingBatches() })))
router.post('/:id/enroll', enquiryLimiter, validate(schemas.batchEnroll), handle(async (req, res) => {
  const data = await service.enroll(Number(req.params.id), req.body, { ip: req.ip, userAgent: req.get('user-agent') })
  return success(res, { message: data.already ? "You're already enrolled in this batch" : "You're enrolled — our team will contact you shortly", data })
}))

export default router
