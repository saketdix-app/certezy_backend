// src/modules/imports/standardCatalog.js
// Ready-made certification course packs that ship with the API
// (seeds/standard/<pack>/{courses,curriculum,quizzes}.csv).
//
// Packs import as DRAFT, FREE courses so an admin can review the content,
// set the real price and thumbnail, then publish. Importing a pack again
// updates it instead of duplicating it.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runImport } from './imports.service.js'
import { AppError } from '../../utils/http.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../seeds/standard')
const FILES = ['courses', 'curriculum', 'quizzes']

const readManifest = async () => JSON.parse(await fs.readFile(path.join(ROOT, 'packs.json'), 'utf8'))

export const listPacks = async () => {
  const { packs } = await readManifest()
  return packs
}

export const importPack = async (packId, { dry_run = false } = {}, userId) => {
  const packs = await listPacks()
  const pack = packs.find((p) => p.id === packId)
  if (!pack) throw AppError.notFound('Course pack')

  const results = {}
  for (const type of FILES) {
    const file = path.join(ROOT, pack.id, `${type}.csv`)
    const csv = await fs.readFile(file, 'utf8').catch(() => null)
    if (!csv) continue
    // Curriculum/quizzes need the course rows to exist, so a dry run can only
    // preview the courses file; a real import runs all three in order.
    if (dry_run && type !== 'courses') continue
    results[type] = await runImport(type, { csv, dry_run, create_missing_categories: true }, userId)
  }
  return { pack: pack.id, dry_run, results }
}
