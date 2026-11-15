// src/modules/team/team.controller.js

import * as service from './team.service.js'
import { listAuditLogs } from '../../utils/audit.js'
import { success } from '../../utils/response.js'

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res)
  } catch (err) {
    next(err)
  }
}

// GET /admin/team?role&status&search
export const list = handle(async (req, res) => {
  const members = await service.listTeam(req.query)
  return success(res, { data: { members, me: await service.myCapabilities(req.user) } })
})

// GET /admin/team/:id
export const get = handle(async (req, res) => success(res, { data: await service.getMember(req.params.id) }))

// POST /admin/team
export const create = handle(async (req, res) =>
  success(res, {
    statusCode: 201,
    message: 'Account created — an invitation to set a password was sent',
    data: await service.createMember(req, req.body),
  })
)

// POST /admin/team/:id/resend-invite
export const resendInvite = handle(async (req, res) =>
  success(res, { message: 'Invitation sent again', data: await service.resendInvite(req, req.params.id) })
)

// PATCH /admin/team/:id/role
export const changeRole = handle(async (req, res) =>
  success(res, { message: 'Role updated', data: await service.changeRole(req, req.params.id, req.body) })
)

// PATCH /admin/team/:id/status
export const setStatus = handle(async (req, res) =>
  success(res, {
    message: req.body.is_active ? 'Account activated' : 'Account deactivated',
    data: await service.setStatus(req, req.params.id, req.body.is_active),
  })
)

// POST /admin/team/:id/privileges/super-admin-create
export const grant = handle(async (req, res) =>
  success(res, { message: 'Privilege granted', data: await service.grantPrivilege(req, req.params.id, req.body) })
)

// DELETE /admin/team/:id/privileges/super-admin-create
export const revoke = handle(async (req, res) =>
  success(res, { message: 'Privilege revoked', data: await service.revokePrivilege(req, req.params.id, req.body) })
)

// GET /admin/team/audit?action&actor_id&target_id&page&limit
export const audit = handle(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
  const data = await listAuditLogs({
    action: req.query.action || undefined,
    actorId: Number(req.query.actor_id) || undefined,
    targetType: req.query.target_id ? 'user' : undefined,
    targetId: Number(req.query.target_id) || undefined,
    page,
    limit,
  })
  return success(res, { data })
})
