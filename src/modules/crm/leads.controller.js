// src/modules/crm/leads.controller.js

import * as service from './leads.service.js'
import * as distribution from './distribution.service.js'
import { success } from '../../utils/response.js'

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res)
  } catch (err) {
    next(err)
  }
}

export const dashboard = handle(async (req, res) => success(res, { data: await service.dashboard(req.user) }))
export const list = handle(async (req, res) => success(res, { data: await service.listLeads(req.user, req.query) }))
export const get = handle(async (req, res) => success(res, { data: await service.getLead(req.user, req.params.id) }))
export const owners = handle(async (req, res) => success(res, { data: await service.assignableOwners(req.user) }))
export const followUps = handle(async (req, res) =>
  success(res, { data: await service.listFollowUps(req.user, req.query) })
)

export const create = handle(async (req, res) =>
  success(res, { statusCode: 201, message: 'Lead added', data: await service.createLead(req, req.body) })
)
export const update = handle(async (req, res) =>
  success(res, { message: 'Lead updated', data: await service.updateLead(req, req.params.id, req.body) })
)
export const changeStage = handle(async (req, res) =>
  success(res, { message: 'Status updated', data: await service.changeStage(req, req.params.id, req.body) })
)
export const logActivity = handle(async (req, res) =>
  success(res, { message: 'Saved', data: await service.logActivity(req, req.params.id, req.body) })
)
export const scheduleFollowUp = handle(async (req, res) =>
  success(res, { message: 'Follow-up scheduled', data: await service.scheduleFollowUp(req, req.params.id, req.body) })
)
export const completeFollowUp = handle(async (req, res) =>
  success(res, { message: 'Follow-up updated', data: await service.completeFollowUp(req, req.params.id, req.body) })
)

// ── Distribution (phase 4, Admins) ──
export const distributionGet = handle(async (req, res) => success(res, { data: await distribution.listPools(req.user) }))
export const distributionSetting = handle(async (req, res) =>
  success(res, { message: 'Saved', data: await distribution.setRoundRobin(req, req.body.round_robin_enabled) })
)
export const poolCreate = handle(async (req, res) =>
  success(res, { statusCode: 201, message: 'Pool saved', data: await distribution.savePool(req, null, req.body) })
)
export const poolUpdate = handle(async (req, res) =>
  success(res, { message: 'Pool saved', data: await distribution.savePool(req, Number(req.params.id), req.body) })
)
export const poolDelete = handle(async (req, res) =>
  success(res, { message: 'Pool deleted', data: await distribution.deletePool(req, req.params.id) })
)
export const distributeQueue = handle(async (req, res) => {
  const r = await distribution.distributeQueue(req)
  return success(res, { message: `${r.assigned} assigned, ${r.waiting} still waiting`, data: r })
})
export const report = handle(async (req, res) =>
  success(res, { data: await distribution.distributionReport(req.user, req.query) })
)
export const movePreview = handle(async (req, res) =>
  success(res, { data: await distribution.previewMove(req.user, req.body) })
)
export const move = handle(async (req, res) => {
  const r = await distribution.moveLeads(req, req.body)
  return success(res, { message: `${r.moved} lead${r.moved === 1 ? '' : 's'} moved`, data: r })
})
