// scripts/refresh-certificates.js
// Rebuilds the PDF of every issued certificate with the current design and
// issuer name. Certificate numbers, dates and verify links stay the same.
//
//   npm run certificates:refresh
import { pool } from '../src/config/db.js'
import { refreshAllCertificatePdfs } from '../src/modules/certificates/certificates.service.js'

const main = async () => {
  const result = await refreshAllCertificatePdfs({
    onProgress: (p) => console.log(p.ok ? `✓ ${p.certificate_no}` : `✗ certificate #${p.id}: ${p.error}`),
  })
  console.log(`\nRebuilt ${result.done} of ${result.total} certificates${result.failed.length ? `, ${result.failed.length} failed` : ''}.`)
  if (result.failed.length) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error('✗', err.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
    process.exit()
  })
