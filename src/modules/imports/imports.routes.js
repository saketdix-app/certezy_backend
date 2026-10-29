// src/modules/imports/imports.routes.js
//
//   GET  /imports/templates              list importable types + column docs
//   GET  /imports/templates/:type.csv    download sample CSV (courses|curriculum|quizzes)
//   POST /imports/:type                  { csv, dry_run } — validate (+ preview) or import
//   GET  /imports/standard               bundled AWS / Azure course packs
//   POST /imports/standard/:packId       import a bundled pack (packId 'all' = every pack)

import { Router } from 'express'
import * as controller from './imports.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import permission from '../../middleware/permission.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

const admin = [authenticate, role('admin', 'sub_admin')]
// Quizzes are test content; everything else is course content
const permissionFor = (req, res, next) =>
  permission(req.params.type === 'quizzes' ? 'can_manage_tests' : 'can_manage_courses')(req, res, next)

router.get('/templates', ...admin, controller.listTemplates)
router.get('/templates/:type', ...admin, controller.downloadTemplate)

router.get('/standard', ...admin, permission('can_manage_courses'), controller.listStandardPacks)
router.post('/standard/:packId', ...admin, permission('can_manage_courses'), controller.importStandardPack)

router.post('/:type', ...admin, permissionFor, validate(schemas.csvImport), controller.runImport)

export default router
