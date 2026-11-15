// src/modules/team/team.routes.js
// 2.0 Phase 1 — Team (staff accounts), Super Admin delegation, audit log.
// Role checks here are the coarse gate; team.service applies the detailed rules.

import { Router } from 'express'
import * as controller from './team.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()
const managers = [authenticate, role('admin')] // Admins and Super Admins

router.get('/', ...managers, controller.list)
router.get('/audit', ...managers, controller.audit)
router.get('/:id', ...managers, controller.get)
router.post('/', ...managers, validate(schemas.createTeamMember), controller.create)
router.post('/:id/resend-invite', ...managers, controller.resendInvite)
router.patch('/:id/role', ...managers, validate(schemas.changeTeamRole), controller.changeRole)
router.patch('/:id/status', ...managers, validate(schemas.setTeamStatus), controller.setStatus)
router.put('/:id/permissions', ...managers, validate(schemas.teamPermissions), controller.setPermissions)
router.put('/:id/allocation', ...managers, validate(schemas.consultantAllocation), controller.setAllocation)
router.post('/:id/privileges/super-admin-create', ...managers, validate(schemas.reauth), controller.grant)
router.delete('/:id/privileges/super-admin-create', ...managers, validate(schemas.reauth), controller.revoke)

export default router
