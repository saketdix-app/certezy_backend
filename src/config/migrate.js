// src/config/migrate.js
// Small, idempotent schema updates applied at startup.
// Each step checks INFORMATION_SCHEMA first, so running it repeatedly is safe.

import { pool } from './db.js'
import { LESSON_TYPES } from '../constants.js'

const columnInfo = async (table, column) => {
  const [rows] = await pool.query(
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
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

// Widen an ENUM column so it accepts every value in `wanted` (keeps existing ones).
// VARCHAR columns already accept anything, so they are left alone.
const ensureEnumValues = async (table, column, wanted) => {
  const col = await columnInfo(table, column)
  if (!col || !col.COLUMN_TYPE.toLowerCase().startsWith('enum(')) return false
  const current = [...col.COLUMN_TYPE.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
  const missing = wanted.filter((v) => !current.includes(v))
  if (!missing.length) return false
  const values = [...current, ...missing].map((v) => pool.escape(v)).join(', ')
  const nullable = col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'
  const def =
    col.COLUMN_DEFAULT != null ? ` DEFAULT ${pool.escape(col.COLUMN_DEFAULT.replace(/^'|'$/g, ''))}` : ''
  await pool.query(`ALTER TABLE \`${table}\` MODIFY \`${column}\` ENUM(${values}) ${nullable}${def}`)
  return true
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
    name: 'lessons.type accepts every LESSON_TYPES value (text, pdf, link, embed, audio…)',
    run: () => ensureEnumValues('lessons', 'type', LESSON_TYPES),
  },
  {
    name: 'lessons.content can hold long rich text',
    run: async () => {
      const col = await columnInfo('lessons', 'content')
      if (!col || /mediumtext|longtext/i.test(col.COLUMN_TYPE)) return false
      await pool.query('ALTER TABLE lessons MODIFY content MEDIUMTEXT NULL')
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
  {
    name: 'courses.pricing_type (free | paid)',
    run: async () => {
      const added = await addColumnIfMissing(
        'courses',
        'pricing_type',
        "ENUM('free','paid') NOT NULL DEFAULT 'paid' AFTER price"
      )
      // Existing ₹0/$0 courses become explicit free courses
      if (added) await pool.query("UPDATE courses SET pricing_type = 'free' WHERE price <= 0")
      return added
    },
  },
  {
    name: 'courses.original_price (list price for discounted courses)',
    run: () => addColumnIfMissing('courses', 'original_price', 'DECIMAL(10,2) NULL AFTER price'),
  },
  {
    name: 'reviews.updated_at (students can edit their review)',
    run: () =>
      addColumnIfMissing('reviews', 'updated_at', 'TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP'),
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
