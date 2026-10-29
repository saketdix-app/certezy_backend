// src/modules/imports/imports.controller.js

import * as service from './imports.service.js'
import * as standard from './standardCatalog.js'
import { TEMPLATES, IMPORT_TYPES, templateCsv } from './imports.templates.js'
import { success } from '../../utils/response.js'
import { AppError, asyncHandler } from '../../utils/http.js'

// GET /imports/templates — what can be imported + column docs
const listTemplates = asyncHandler(async (req, res) => {
  const data = IMPORT_TYPES.map((type) => ({
    type,
    label: TEMPLATES[type].label,
    description: TEMPLATES[type].description,
    columns: TEMPLATES[type].columns,
  }))
  return success(res, { message: 'Import templates', data })
})

// GET /imports/templates/:type.csv — download the sample CSV
const downloadTemplate = asyncHandler(async (req, res) => {
  const type = req.params.type.replace(/\.csv$/, '')
  if (!TEMPLATES[type]) throw AppError.notFound('Template')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="certezy-${type}-sample.csv"`)
  return res.send(templateCsv(type))
})

// POST /imports/:type { csv, dry_run?, create_missing_categories? }
const runImport = asyncHandler(async (req, res) => {
  const result = await service.runImport(req.params.type, req.body, req.user.id)
  return success(res, {
    message: result.dry_run ? 'Preview ready — nothing saved yet' : 'Import completed',
    data: result,
  })
})

// GET /imports/standard — bundled AWS / Azure course packs
const listStandardPacks = asyncHandler(async (req, res) => {
  return success(res, { message: 'Standard course packs', data: await standard.listPacks() })
})

// POST /imports/standard/:packId { dry_run? }
const importStandardPack = asyncHandler(async (req, res) => {
  const result = await standard.importPack(req.params.packId, { dry_run: !!req.body?.dry_run }, req.user.id)
  return success(res, { message: result.dry_run ? 'Preview ready' : 'Course pack imported', data: result })
})

export { listTemplates, downloadTemplate, runImport, listStandardPacks, importStandardPack }
