// src/config/migrate.js
// Small, idempotent schema updates applied at startup.
// Each step checks INFORMATION_SCHEMA first, so running it repeatedly is safe.

import { pool } from './db.js'

const columnInfo = async (table, column) => {
  const [rows] = await pool.query(
    `SELECT COLUMN_TYPE, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  )
  return rows[0] || null
}

const addColumnIfMissing = async (table, column, definition) => {
  if (await columnInfo(table, column)) return false
  await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  return true
}

// Every table the API reads or writes. Missing ones are reported at startup.
const REQUIRED_TABLES = [
  'users',
  'refresh_tokens',
  'oauth_accounts',
  'admin_permissions',
  'categories',
  'courses',
  'sections',
  'lessons',
  'lesson_progress',
  'tests',
  'questions',
  'options',
  'test_attempts',
  'attempt_answers',
  'enrollments',
  'payments',
  'discount_links',
  'certificates',
  'reviews',
  'contacts',
]

const tableExists = async (table) => {
  const [rows] = await pool.query(
    'SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  )
  return rows.length > 0
}

const STEPS = [
  {
    name: 'contacts table (contact form enquiries)',
    run: async () => {
      if (await tableExists('contacts')) return false
      await pool.query(`
        CREATE TABLE contacts (
          id         INT AUTO_INCREMENT PRIMARY KEY,
          user_id    INT NULL,
          name       VARCHAR(150) NOT NULL,
          email      VARCHAR(255) NOT NULL,
          phone      VARCHAR(30)  NULL,
          subject    VARCHAR(200) NOT NULL,
          message    TEXT         NOT NULL,
          status     VARCHAR(20)  NOT NULL DEFAULT 'new',
          created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_contacts_status (status),
          INDEX idx_contacts_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'enrollments.payment_id nullable (free / admin-assigned enrollments)',
    run: async () => {
      const col = await columnInfo('enrollments', 'payment_id')
      if (!col || col.IS_NULLABLE === 'YES') return false
      await pool.query(`ALTER TABLE enrollments MODIFY payment_id ${col.COLUMN_TYPE} NULL`)
      return true
    },
  },
  {
    name: 'enrollments.source',
    // purchase = paid checkout, admin = assigned free by an admin / sub-admin
    run: () => addColumnIfMissing('enrollments', 'source', "VARCHAR(20) NOT NULL DEFAULT 'purchase'"),
  },
  {
    name: 'enrollments.assigned_by',
    run: () => addColumnIfMissing('enrollments', 'assigned_by', 'INT NULL'),
  },
  {
    name: 'enrollments.note',
    run: () => addColumnIfMissing('enrollments', 'note', 'VARCHAR(255) NULL'),
  },
]

/**
 * Apply pending schema steps. Never throws: a failed step is logged and the
 * API keeps running (features depending on it return a clear error instead).
 */
const runMigrations = async () => {
  for (const step of STEPS) {
    try {
      const applied = await step.run()
      if (applied) console.log(`🛠  Migration applied: ${step.name}`)
    } catch (err) {
      console.error(`⚠️  Migration failed (${step.name}): ${err.message}`)
    }
  }

  // Report anything else the code expects but the database doesn't have
  try {
    const missing = []
    for (const table of REQUIRED_TABLES) {
      if (!(await tableExists(table))) missing.push(table)
    }
    if (missing.length) {
      console.error(`⚠️  Missing database tables: ${missing.join(', ')} — features using them will fail`)
    }
  } catch (err) {
    console.error(`⚠️  Schema check failed: ${err.message}`)
  }
}

export default runMigrations
