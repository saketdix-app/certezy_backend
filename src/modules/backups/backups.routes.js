// src/modules/backups/backups.routes.js
// Admin → Backups (Super Admins only; checked in the service too).

import { Router } from 'express'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { success } from '../../utils/response.js'
import * as service from './backups.service.js'

const router = Router()
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res)
  } catch (err) {
    next(err)
  }
}
const superAdmin = [authenticate, role('super_admin')]

router.get('/', ...superAdmin, handle(async (req, res) => success(res, { data: await service.overview(req.user) })))
router.post('/run', ...superAdmin, handle(async (req, res) => success(res, { message: 'Backup started', data: await service.backupNow(req) })))
router.get('/:id/download', ...superAdmin, handle(async (req, res) => success(res, { data: await service.downloadLink(req, Number(req.params.id)) })))

export default router
