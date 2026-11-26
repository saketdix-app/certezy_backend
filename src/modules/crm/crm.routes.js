// src/modules/crm/crm.routes.js
// 2.0 Phase 3 — lead CRM for Consultants (own leads), Exam Coordinators
// (leads assigned to them for the exam) and Admins (all leads).
// leads.service applies record-level access on every call.

import { Router } from 'express'
import * as controller from './leads.controller.js'
import authenticate from '../../middleware/auth.js'
import { crmRoles } from '../../utils/access.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()
// Sales side (Super Admins pass as Admins)
// Sub-Admins with CRM access (Team → Permissions) pass as Admins
const crm = [authenticate, crmRoles('admin', 'consultant')]
// Also Exam Coordinators: their leads, notes, WhatsApp, the exam and Course Done
const crmAll = [authenticate, crmRoles('admin', 'consultant', 'exam_coordinator')]

router.get('/dashboard', ...crmAll, controller.dashboard)
router.get('/follow-ups', ...crmAll, controller.followUps)
router.patch('/follow-ups/:id', ...crm, validate(schemas.completeFollowUp), controller.completeFollowUp)
router.get('/owners', ...crmAll, controller.owners)
// Admin → By consultant: leads per consultant, progress and client discussion
router.get('/consultants/progress', ...crm, controller.consultantProgress)
router.get('/leads', ...crmAll, controller.list)
// My leads I haven't opened since they were assigned (red dot on the tab / menu)
router.get('/leads/new-count', ...crmAll, controller.newCount)
// Team app: match the phone's call log to leads on the phone, then record those calls
router.get('/leads/phone-index', ...crmAll, controller.phoneIndex)
router.post('/calls/sync', ...crmAll, validate(schemas.callSync), controller.syncCalls)
// Saved WhatsApp / email messages
router.get('/templates', ...crmAll, controller.templatesList)
router.post('/templates', ...crmAll, validate(schemas.messageTemplate), controller.templatesCreate)
router.put('/templates/:id', ...crmAll, validate(schemas.messageTemplate), controller.templatesUpdate)
router.delete('/templates/:id', ...crmAll, controller.templatesDelete)
// CERTEZY Team app: latest APK (for "Check for updates"); Admins publish it
router.get('/app-release', ...crmAll, controller.appReleaseGet)
router.put('/app-release', ...crm, validate(schemas.appRelease), controller.appReleaseSave)
router.post('/leads', ...crm, validate(schemas.createLead), controller.create)
router.post('/leads/assign/preview', ...crm, validate(schemas.moveLeads), controller.movePreview)
router.post('/leads/assign', ...crm, validate(schemas.moveLeads), controller.move)
// Super Admin only, with their password: delete leads for good
router.post('/leads/delete', ...crm, validate(schemas.deleteLeads), controller.remove)
// Upload leads from a CSV (dry_run checks the file first)
router.post('/leads/import', ...crm, validate(schemas.leadImport), controller.importCsv)
router.get('/leads/:id', ...crmAll, controller.get)
router.patch('/leads/:id', ...crm, validate(schemas.updateLead), controller.update)
router.post('/leads/:id/stage', ...crmAll, validate(schemas.changeLeadStage), controller.changeStage)
router.post('/leads/:id/activities', ...crmAll, validate(schemas.leadActivity), controller.logActivity)
router.post('/leads/:id/follow-ups', ...crm, validate(schemas.scheduleFollowUp), controller.scheduleFollowUp)

// Exam: coordinator picker and assignment (consultant / Admin), exam updates (anyone with access)
router.get('/exam-coordinators', ...crm, controller.examCoordinators)
router.put('/leads/:id/exam-coordinator', ...crm, validate(schemas.leadExamCoordinator), controller.setExamCoordinator)
router.put('/leads/:id/exam', ...crmAll, validate(schemas.leadExam), controller.updateExam)
// Application Submitted (consultant / Admin); Payment Due ↔ Done (anyone with access → Course Done)
router.put('/leads/:id/application', ...crm, validate(schemas.leadApplication), controller.updateApplication)
router.put('/leads/:id/payment', ...crmAll, validate(schemas.leadPayment), controller.updatePayment)

// CRM → LMS actions from a lead (permission + ownership checked in the service)
router.post('/leads/:id/student-account', ...crm, controller.studentAccount)
router.post('/leads/:id/assign-course', ...crm, validate(schemas.leadAssignCourse), controller.assignCourse)
router.post('/leads/:id/discount-link', ...crm, validate(schemas.leadDiscount), controller.sendDiscount)
router.post('/leads/:id/certificate', ...crm, validate(schemas.leadCertificate), controller.issueCertificate)
router.post('/discounts/:id/revoke', ...crm, validate(schemas.revokeDiscount), controller.revokeDiscount)
router.get('/discounts', ...crm, controller.discounts)
router.get('/assignments', ...crm, controller.assignments)
router.get('/certificates', ...crm, controller.certificates)
router.get('/sales', ...crm, controller.sales)
router.get('/settings', ...crm, controller.settings)
router.put('/settings', ...crm, validate(schemas.crmSettings), controller.saveSettings)

// WhatsApp conversation on a lead, and automations (phase 8)
router.get('/leads/:id/whatsapp', ...crmAll, controller.whatsappThread)
router.post('/leads/:id/whatsapp', ...crmAll, validate(schemas.whatsappSend), controller.whatsappSend)
router.get('/whatsapp/templates', ...crmAll, controller.whatsappTemplates)
router.get('/automations', ...crm, controller.automationsGet)
router.put('/automations', ...crm, validate(schemas.automations), controller.automationsSave)

// Reports (Admins; the service checks the role)
router.get('/reports/overview', ...crm, controller.reportOverview)
router.get('/reports/leads.csv', ...crm, controller.reportExport)
router.get('/reports/calls', ...crm, controller.reportCalls)
router.get('/reports/follow-ups', ...crm, controller.reportFollowUps)
router.get('/reports/team', ...crm, controller.reportTeam)

// Distribution (Admins; the service checks the role)
router.get('/distribution', ...crm, controller.distributionGet)
router.put('/distribution/settings', ...crm, validate(schemas.roundRobinSetting), controller.distributionSetting)
router.post('/distribution/pools', ...crm, validate(schemas.distributionPool), controller.poolCreate)
router.put('/distribution/pools/:id', ...crm, validate(schemas.distributionPool), controller.poolUpdate)
router.delete('/distribution/pools/:id', ...crm, controller.poolDelete)
router.post('/distribution/run', ...crm, controller.distributeQueue)
router.get('/distribution/report', ...crm, controller.report)

export default router
