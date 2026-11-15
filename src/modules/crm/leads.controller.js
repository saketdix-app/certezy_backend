// src/modules/crm/leads.controller.js

import * as service from './leads.service.js'
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
