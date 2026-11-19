// src/modules/team/team.controller.js

import * as service from './team.service.js'
import { handoverFrom, handoverSummary } from '../crm/distribution.service.js'
import { listAuditLogs } from '../../utils/audit.js'
import { success } from '../../utils/response.js'

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res)
  } catch (err) {
    next(err)
  }
}

// GET /admin/team/:id/handover — open leads and exams this person still has
export const handoverInfo = handle(async (req, res) => success(res, { data: await handoverSummary(req.user, req.params.id) }))

// POST /admin/team/:id/handover — move them (before blocking, deleting or a role change)
export const handover = handle(async (req, res) => {
  const result = await handoverFrom(req, req.params.id, req.body)
  return success(res, { message: 'Leads handed over', data: { ...result, summary: await handoverSummary(req.user, req.params.id) } })
})

// DELETE /admin/team/:id  { confirm_email, handover? } — hand over first if anything is still open
export const remove = handle(async (req, res) => {
  const target = await service.assertCanDelete(req, req.params.id, req.body.confirm_email)
  if (req.body.handover) await handoverFrom(req, target.id, req.body.handover)
  const left = await handoverSummary(req.user, target.id)
  if (left.open_leads || left.open_exams) {
    const err = new Error(
      `Hand over their ${left.open_leads} open lead(s) and ${left.open_exams} open exam(s) before deleting this account`
    )
    err.statusCode = 409
    err.details = left
    throw err
  }
  return success(res, { message: 'Team member deleted', data: await service.deleteMember(req, target) })
})

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
export const update = handle(async (req, res) =>
  success(res, { message: 'Details updated', data: await service.updateMember(req, req.params.id, req.body) })
)
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

// PUT /admin/team/:id/permissions — Sub-Admin / Consultant permissions
export const setPermissions = handle(async (req, res) =>
  success(res, { message: 'Permissions updated', data: await service.setPermissions(req, req.params.id, req.body) })
)

// PUT /admin/team/:id/allocation — Consultant: receive leads / pause / leave / limits
export const setAllocation = handle(async (req, res) =>
  success(res, { message: 'Lead allocation updated', data: await service.setAllocation(req, req.params.id, req.body) })
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
