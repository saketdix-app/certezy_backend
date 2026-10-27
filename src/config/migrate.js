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

const STEPS = [
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
}

export default runMigrations
