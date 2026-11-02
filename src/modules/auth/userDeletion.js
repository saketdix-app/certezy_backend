// src/modules/auth/userDeletion.js
// Deleting a user (admin):
//   1. delete  → users.deleted_at is set, the account is switched off and signed
//                out everywhere. Nothing else changes, so it can be restored.
//   2. restore → within RECOVERY_DAYS, everything comes back as it was.
//   3. purge   → after RECOVERY_DAYS the user's data is erased: courses,
//                progress, test attempts, certificates, reviews, discount links,
//                sign-in links and messages. The account row is kept only as an
//                anonymous "Deleted user" so payment and invoice records (which
//                the law requires us to keep) still add up.

import { pool } from '../../config/db.js'

export const RECOVERY_DAYS = 30

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

const getUser = async (id) => {
  const [rows] = await pool.query(
    'SELECT id, name, email, role, is_active, deleted_at, purged_at FROM users WHERE id = ? LIMIT 1',
    [id]
  )
  return rows[0] ?? null
}

export const isDeleted = async (id) => Boolean((await getUser(id))?.deleted_at)

export const purgeDateFor = (deletedAt) =>
  deletedAt ? new Date(new Date(deletedAt).getTime() + RECOVERY_DAYS * 86400e3) : null

// ── Delete (recoverable) ──────────────────────────────────────────────────
export const softDeleteUser = async (id, adminId) => {
  const user = await getUser(id)
  if (!user || user.purged_at) throw fail(404, 'User not found')
  if (user.deleted_at) throw fail(409, 'This user is already deleted')
  if (Number(id) === Number(adminId)) throw fail(400, "You can't delete your own account")
  if (user.role === 'admin') throw fail(403, 'Admin accounts cannot be deleted here')

  await pool.query(
    `UPDATE users
     SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?, was_active = is_active, is_active = 0
     WHERE id = ?`,
    [adminId, id]
  )
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = ?', [id]) // signed out everywhere

  const [[row]] = await pool.query('SELECT deleted_at FROM users WHERE id = ?', [id])
  return { id: user.id, name: user.name, email: user.email, restore_until: purgeDateFor(row.deleted_at) }
}

// ── Restore ───────────────────────────────────────────────────────────────
export const restoreUser = async (id) => {
  const user = await getUser(id)
  if (!user || user.purged_at) throw fail(404, 'User not found — it may have been erased already')
  if (!user.deleted_at) throw fail(409, 'This user is not deleted')
  if (purgeDateFor(user.deleted_at) < new Date()) {
    throw fail(410, `The ${RECOVERY_DAYS}-day recovery period has ended`)
  }

  await pool.query(
    `UPDATE users
     SET deleted_at = NULL, deleted_by = NULL, is_active = COALESCE(was_active, 1), was_active = NULL
     WHERE id = ?`,
    [id]
  )
  return { id: user.id, name: user.name, email: user.email }
}

// ── Purge: erase users deleted more than RECOVERY_DAYS ago ────────────────
// Rows that belong to the user (payments are kept, see top of file)
const OWNED_TABLES = [
  'refresh_tokens',
  'oauth_accounts',
  'admin_permissions',
  'lesson_progress',
  'test_attempts', // answers go with them (ON DELETE CASCADE)
  'enrollments',
  'certificates',
  'reviews',
  'discount_links',
  'contacts',
  'password_resets',
]

const eraseUser = async (id) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    for (const table of OWNED_TABLES) {
      try {
        await conn.query(`DELETE FROM \`${table}\` WHERE user_id = ?`, [id])
      } catch (err) {
        // table or column missing on this install — nothing to erase there
        if (!['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(err.code)) throw err
      }
    }
    await conn.query(
      `UPDATE users
       SET name = 'Deleted user', email = CONCAT('deleted-', id, '@deleted.invalid'),
           password = NULL, mobile = NULL, avatar = NULL, gender = NULL, oauth_id = NULL,
           country = NULL, is_active = 0, purged_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [id]
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export const purgeExpiredUsers = async () => {
  const [rows] = await pool.query(
    `SELECT id FROM users
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL
       AND deleted_at < UTC_TIMESTAMP() - INTERVAL ? DAY`,
    [RECOVERY_DAYS]
  )
  let erased = 0
  for (const { id } of rows) {
    try {
      await eraseUser(id)
      erased++
    } catch (err) {
      console.error(`User purge failed for #${id}: ${err.message}`)
    }
  }
  if (erased) console.log(`🧹 Erased ${erased} user(s) deleted more than ${RECOVERY_DAYS} days ago`)
  return erased
}

/** Run the purge now and then every 6 hours. */
export const schedulePurge = () => {
  const run = () => purgeExpiredUsers().catch((err) => console.error(`User purge failed: ${err.message}`))
  run()
  setInterval(run, 6 * 3600e3).unref()
}
