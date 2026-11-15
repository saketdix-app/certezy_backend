// src/modules/crm/crm.routes.js
// 2.0 Phase 3 — lead CRM for Consultants (own leads) and Admins (all leads).
// leads.service applies record-level access on every call.

import { Router } from 'express'
import * as controller from './leads.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()
const crm = [authenticate, role('admin', 'consultant')] // Super Admins pass as Admins

router.get('/dashboard', ...crm, controller.dashboard)
router.get('/follow-ups', ...crm, controller.followUps)
router.patch('/follow-ups/:id', ...crm, validate(schemas.completeFollowUp), controller.completeFollowUp)
router.get('/owners', ...crm, controller.owners)
router.get('/leads', ...crm, controller.list)
router.post('/leads', ...crm, validate(schemas.createLead), controller.create)
router.post('/leads/assign/preview', ...crm, validate(schemas.moveLeads), controller.movePreview)
router.post('/leads/assign', ...crm, validate(schemas.moveLeads), controller.move)
router.get('/leads/:id', ...crm, controller.get)
router.patch('/leads/:id', ...crm, validate(schemas.updateLead), controller.update)
router.post('/leads/:id/stage', ...crm, validate(schemas.changeLeadStage), controller.changeStage)
router.post('/leads/:id/activities', ...crm, validate(schemas.leadActivity), controller.logActivity)
router.post('/leads/:id/follow-ups', ...crm, validate(schemas.scheduleFollowUp), controller.scheduleFollowUp)

// Distribution (Admins; the service checks the role)
router.get('/distribution', ...crm, controller.distributionGet)
router.put('/distribution/settings', ...crm, validate(schemas.roundRobinSetting), controller.distributionSetting)
router.post('/distribution/pools', ...crm, validate(schemas.distributionPool), controller.poolCreate)
router.put('/distribution/pools/:id', ...crm, validate(schemas.distributionPool), controller.poolUpdate)
router.delete('/distribution/pools/:id', ...crm, controller.poolDelete)
router.post('/distribution/run', ...crm, controller.distributeQueue)
router.get('/distribution/report', ...crm, controller.report)

export default router
