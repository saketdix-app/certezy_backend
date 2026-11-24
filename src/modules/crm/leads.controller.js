// src/modules/crm/leads.controller.js

import * as service from './leads.service.js'
import * as templates from './templates.service.js'
import * as appRelease from './appRelease.service.js'
import { importLeads } from './leadImport.service.js'
import * as distribution from './distribution.service.js'
import * as actions from './actions.service.js'
import { salesReport } from './sales.service.js'
import * as reports from './reports.service.js'
import * as automation from './automation.service.js'
import * as calls from './calls.service.js'
import * as whatsappService from '../integrations/whatsapp.service.js'
import { listTemplates } from '../integrations/whatsapp.adapter.js'
import { success } from '../../utils/response.js'

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res)
  } catch (err) {
    next(err)
  }
}

export const dashboard = handle(async (req, res) => success(res, { data: await service.dashboard(req.user) }))
export const importCsv = handle(async (req, res) => {
  const data = await importLeads(req, req.body)
  return success(res, { message: data.dry_run ? 'File checked' : `${data.created} leads imported`, data })
})
export const newCount = handle(async (req, res) => success(res, { data: await service.newLeadsCount(req.user) }))
export const phoneIndex = handle(async (req, res) => success(res, { data: await calls.phoneIndex(req.user) }))
export const syncCalls = handle(async (req, res) => success(res, { message: 'Calls recorded', data: await calls.syncCalls(req, req.body) }))
export const templatesList = handle(async (req, res) => success(res, { data: await templates.listTemplates(req.user) }))
export const templatesCreate = handle(async (req, res) =>
  success(res, { message: 'Template saved', statusCode: 201, data: await templates.createTemplate(req.user, req.body) })
)
export const templatesUpdate = handle(async (req, res) =>
  success(res, { message: 'Template saved', data: await templates.updateTemplate(req.user, req.params.id, req.body) })
)
export const templatesDelete = handle(async (req, res) =>
  success(res, { message: 'Template deleted', data: await templates.deleteTemplate(req.user, req.params.id) })
)
export const appReleaseGet = handle(async (req, res) => success(res, { data: await appRelease.getRelease() }))
export const appReleaseSave = handle(async (req, res) =>
  success(res, { message: 'App update published', data: await appRelease.saveRelease(req, req.body) })
)
export const remove = handle(async (req, res) => {
  const data = await service.deleteLeads(req, req.body)
  return success(res, { message: data.deleted === 1 ? 'Lead deleted' : `${data.deleted} leads deleted`, data })
})
export const list = handle(async (req, res) => success(res, { data: await service.listLeads(req.user, req.query) }))
export const get = handle(async (req, res) => success(res, { data: await service.getLead(req.user, req.params.id) }))
export const owners = handle(async (req, res) => success(res, { data: await service.assignableOwners(req.user) }))
export const consultantProgress = handle(async (req, res) =>
  success(res, { data: await service.consultantProgress(req.user) })
)
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
export const examCoordinators = handle(async (req, res) =>
  success(res, { data: await service.examCoordinators(req.user) })
)
export const setExamCoordinator = handle(async (req, res) =>
  success(res, { message: 'Exam coordinator updated', data: await service.setExamCoordinator(req, req.params.id, req.body) })
)
export const updateApplication = handle(async (req, res) =>
  success(res, { message: 'Application updated', data: await service.updateApplication(req, req.params.id, req.body) })
)
export const updatePayment = handle(async (req, res) =>
  success(res, { message: 'Payment updated', data: await service.updatePayment(req, req.params.id, req.body) })
)
export const updateExam = handle(async (req, res) =>
  success(res, { message: 'Exam updated', data: await service.updateExam(req, req.params.id, req.body) })
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

// ── CRM → LMS actions and sales (phase 5) ──
export const studentAccount = handle(async (req, res) =>
  success(res, { message: 'Student account ready — they were emailed a link to set a password', data: await actions.createStudentAccount(req, req.params.id) })
)
export const assignCourse = handle(async (req, res) =>
  success(res, { message: 'Course assigned', data: await actions.assignCourse(req, req.params.id, req.body) })
)
export const sendDiscount = handle(async (req, res) =>
  success(res, { statusCode: 201, message: 'Discount link sent', data: await actions.sendDiscount(req, req.params.id, req.body) })
)
export const issueCertificate = handle(async (req, res) =>
  success(res, { statusCode: 201, message: 'Certificate issued', data: await actions.issueLeadCertificate(req, req.params.id, req.body) })
)
export const revokeDiscount = handle(async (req, res) =>
  success(res, { message: 'Discount link withdrawn', data: await actions.revokeDiscount(req, req.params.id, req.body) })
)
export const discounts = handle(async (req, res) => success(res, { data: await actions.listDiscountLinks(req.user) }))
export const assignments = handle(async (req, res) => success(res, { data: await actions.listAssignments(req.user) }))
export const certificates = handle(async (req, res) => success(res, { data: await actions.listIssuedCertificates(req.user) }))
export const sales = handle(async (req, res) => success(res, { data: await salesReport(req.user, req.query) }))
export const settings = handle(async (req, res) =>
  success(res, {
    data: { max_discount_pct: await actions.getMaxDiscountPct(), round_robin_enabled: await distribution.isRoundRobinOn() },
  })
)
export const saveSettings = handle(async (req, res) =>
  success(res, { message: 'Saved', data: await actions.setMaxDiscountPct(req, req.body.max_discount_pct) })
)

// ── Reports (phase 6, Admins) ──
export const reportOverview = handle(async (req, res) => success(res, { data: await reports.overview(req.user, req.query) }))
export const reportExport = handle(async (req, res) => {
  const csv = await reports.exportLeads(req, req.query)
  const day = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="certezy-leads-${day}.csv"`)
  res.setHeader('Cache-Control', 'no-store')
  return res.send(`\uFEFF${csv}`) // BOM so Excel reads ₹ and accents correctly
})

// ── WhatsApp & automations (phase 8) ──
export const whatsappThread = handle(async (req, res) => success(res, { data: await whatsappService.thread(req.user, req.params.id) }))
export const whatsappSend = handle(async (req, res) =>
  success(res, { message: 'Sent on WhatsApp', data: await whatsappService.sendFromLead(req, req.params.id, req.body) })
)
export const whatsappTemplates = handle(async (req, res) => success(res, { data: await listTemplates() }))
export const automationsGet = handle(async (req, res) => success(res, { data: await automation.getAutomations() }))
export const automationsSave = handle(async (req, res) =>
  success(res, { message: 'Saved', data: await automation.setAutomations(req, req.body) })
)
