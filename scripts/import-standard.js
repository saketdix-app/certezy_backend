// scripts/import-standard.js
// Import the bundled AWS / Azure course packs from the command line.
//
//   npm run seed:standard                      # all packs
//   npm run seed:standard -- azure-fundamentals  # one pack
//
// Courses are created as DRAFT + FREE and owned by the first admin user.

import { pool } from '../src/config/db.js'
import { listPacks, importPack } from '../src/modules/imports/standardCatalog.js'

const [, , ...ids] = process.argv

const main = async () => {
  const [admins] = await pool.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
  const ownerId = admins[0]?.id ?? null

  const packs = await listPacks()
  const selected = ids.length ? packs.filter((p) => ids.includes(p.id)) : packs
  if (!selected.length) throw new Error(`Unknown pack. Available: ${packs.map((p) => p.id).join(', ')}`)

  for (const pack of selected) {
    const { results } = await importPack(pack.id, {}, ownerId)
    const summary = Object.entries(results)
      .map(
        ([type, r]) =>
          `${type}: ${JSON.stringify(r.summary.created)} created, ${JSON.stringify(r.summary.updated)} updated`
      )
      .join(' · ')
    console.log(`✓ ${pack.title}\n    ${summary}`)
  }
}

main()
  .catch((err) => {
    console.error('✗', err.message, err.errors ? JSON.stringify(err.errors, null, 2) : '')
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
    process.exit()
  })
