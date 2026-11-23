// src/modules/team/team.routes.js
// 2.0 Phase 1 — Team (staff accounts), Super Admin delegation, audit log.
// Role checks here are the coarse gate; team.service applies the detailed rules.

import { Router } from 'express'
import * as controller from './team.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { allow } from '../../utils/access.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()
// Admins and Super Admins, and Sub-Admins with "Team" (Team → Permissions)
const managers = [authenticate, allow('can_manage_team')]

router.get('/', ...managers, controller.list)
router.get('/audit', authenticate, role('admin'), controller.audit)
router.get('/:id', ...managers, controller.get)
router.post('/', ...managers, validate(schemas.createTeamMember), controller.create)
router.post('/:id/resend-invite', ...managers, controller.resendInvite)
router.patch('/:id', ...managers, validate(schemas.updateTeamMember), controller.update)
router.patch('/:id/role', ...managers, validate(schemas.changeTeamRole), controller.changeRole)
router.patch('/:id/status', ...managers, validate(schemas.setTeamStatus), controller.setStatus)
router.get('/:id/handover', ...managers, controller.handoverInfo)
router.post('/:id/handover', ...managers, validate(schemas.teamHandover), controller.handover)
router.delete('/:id', ...managers, validate(schemas.teamDelete), controller.remove)
router.put('/:id/permissions', ...managers, validate(schemas.teamPermissions), controller.setPermissions)
router.put('/:id/allocation', ...managers, validate(schemas.consultantAllocation), controller.setAllocation)
router.post('/:id/privileges/super-admin-create', ...managers, validate(schemas.reauth), controller.grant)
router.delete('/:id/privileges/super-admin-create', ...managers, validate(schemas.reauth), controller.revoke)

export default router
