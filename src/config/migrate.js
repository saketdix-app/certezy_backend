// src/config/migrate.js
// Small, idempotent schema updates applied at startup.
// Each step checks INFORMATION_SCHEMA first, so running it repeatedly is safe.

import { pool } from './db.js'
import env from './env.js'
import { LESSON_TYPES, STAFF_ROLES } from '../constants.js'

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
  'user_permission_grants',
  'audit_logs',
  'consultant_settings',
  'leads',
  'lead_activities',
  'lead_follow_ups',
  'distribution_pools',
  'distribution_pool_members',
  'crm_settings',
  'user_notifications',
  'integrations',
  'lead_ingest_events',
  'whatsapp_messages',
  'integration_secrets',
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
    name: 'courses.price_inr (price for India, in rupees)',
    run: () => addColumnIfMissing('courses', 'price_inr', 'DECIMAL(10,2) NULL AFTER original_price'),
  },
  {
    name: 'courses.original_price_inr (list price for India, in rupees)',
    run: () => addColumnIfMissing('courses', 'original_price_inr', 'DECIMAL(10,2) NULL AFTER price_inr'),
  },
  {
    name: 'reviews.user_id nullable (reviews entered by an admin have no student account)',
    run: async () => {
      const col = await columnInfo('reviews', 'user_id')
      if (!col || col.IS_NULLABLE === 'YES') return false
      await pool.query(`ALTER TABLE reviews MODIFY user_id ${col.COLUMN_TYPE} NULL`)
      return true
    },
  },
  {
    name: 'reviews.source (platform | classroom | corporate | other_platform | feedback_form)',
    run: () => addColumnIfMissing('reviews', 'source', "VARCHAR(20) NOT NULL DEFAULT 'platform'"),
  },
  {
    name: 'reviews.reviewer_name (name shown for admin-entered reviews)',
    run: () => addColumnIfMissing('reviews', 'reviewer_name', 'VARCHAR(100) NULL'),
  },
  {
    name: 'reviews.source_note (e.g. "PMP weekend batch, Pune — Mar 2025")',
    run: () => addColumnIfMissing('reviews', 'source_note', 'VARCHAR(255) NULL'),
  },
  {
    name: 'reviews.reviewed_at (original review date)',
    run: () => addColumnIfMissing('reviews', 'reviewed_at', 'DATE NULL'),
  },
  {
    name: 'reviews.created_by (admin who entered the review)',
    run: () => addColumnIfMissing('reviews', 'created_by', 'INT NULL'),
  },
  {
    name: 'discount_links.user_id nullable (discount sent to an email without an account)',
    run: async () => {
      const col = await columnInfo('discount_links', 'user_id')
      if (!col || col.IS_NULLABLE === 'YES') return false
      await pool.query(`ALTER TABLE discount_links MODIFY user_id ${col.COLUMN_TYPE} NULL`)
      return true
    },
  },
  {
    name: 'discount_links.email (who an email-only discount is for)',
    run: () => addColumnIfMissing('discount_links', 'email', 'VARCHAR(150) NULL AFTER user_id'),
  },
  {
    name: 'reviews.updated_at (students can edit their review)',
    run: () =>
      addColumnIfMissing('reviews', 'updated_at', 'TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP'),
  },
  {
    // No foreign key: on some installs users.id has a different integer type,
    // which made the constraint (and so the whole table) fail. Rows go with
    // the user in the account purge (userDeletion.js).
    name: 'password_resets table (forgot-password links)',
    run: async () => {
      if (await tableExists('password_resets')) return false
      await pool.query(`
        CREATE TABLE password_resets (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          user_id     INT NOT NULL,
          token_hash  CHAR(64) NOT NULL,
          expires_at  DATETIME NOT NULL,
          used_at     DATETIME NULL,
          created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_password_resets_token (token_hash),
          INDEX idx_password_resets_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'contact_replies table (admin replies to contact messages)',
    run: async () => {
      if (await tableExists('contact_replies')) return false
      await pool.query(`
        CREATE TABLE contact_replies (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          contact_id  INT NOT NULL,
          admin_id    INT NULL,
          message     TEXT NOT NULL,
          created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_contact_replies_contact (contact_id),
          FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'certificates.training_start / training_end (training period on the certificate)',
    run: async () => {
      const a = await addColumnIfMissing('certificates', 'training_start', 'DATE NULL AFTER issued_at')
      const b = await addColumnIfMissing('certificates', 'training_end', 'DATE NULL AFTER training_start')
      return a || b
    },
  },
  {
    name: 'courses.inr_enabled (sell in rupees to India; off = USD for everyone)',
    run: () =>
      addColumnIfMissing('courses', 'inr_enabled', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER original_price_inr'),
  },
  {
    name: 'users.deleted_at / deleted_by / was_active / purged_at (delete with 30-day recovery)',
    run: async () => {
      const added = await Promise.all([
        addColumnIfMissing('users', 'deleted_at', 'DATETIME NULL'),
        addColumnIfMissing('users', 'deleted_by', 'INT NULL'),
        addColumnIfMissing('users', 'was_active', 'TINYINT(1) NULL'),
        addColumnIfMissing('users', 'purged_at', 'DATETIME NULL'),
      ])
      return added.some(Boolean)
    },
  },
  {
    name: 'discount_links.discount_price_inr (rupee price set by the admin)',
    run: () =>
      addColumnIfMissing('discount_links', 'discount_price_inr', 'DECIMAL(10,2) NULL AFTER discount_price'),
  },
  {
    name: 'discount_links.sent_count / last_sent_at (resend tracking)',
    run: async () => {
      const a = await addColumnIfMissing('discount_links', 'sent_count', 'INT NOT NULL DEFAULT 1')
      const b = await addColumnIfMissing('discount_links', 'last_sent_at', 'DATETIME NULL')
      return a || b
    },
  },
  {
    name: 'users.country (where students sign in from — admin reports)',
    run: async () => {
      if (!(await addColumnIfMissing('users', 'country', 'CHAR(2) NULL AFTER mobile'))) return false
      await pool.query('CREATE INDEX idx_users_country ON users (country)')
      // First guess for existing students; the next sign-in fills the rest from their IP
      await pool.query(
        `UPDATE users u SET u.country = 'IN'
         WHERE u.country IS NULL
           AND (u.mobile LIKE '+91%'
             OR EXISTS (SELECT 1 FROM payments p
                        WHERE p.user_id = u.id AND p.status = 'success' AND p.currency = 'INR'))`
      )
      const prefixes = [
        ['+971', 'AE'],
        ['+61', 'AU'],
        ['+44', 'GB'],
        ['+65', 'SG'],
        ['+1', 'US'],
      ]
      for (const [prefix, cc] of prefixes) {
        await pool.query(`UPDATE users SET country = ? WHERE country IS NULL AND mobile LIKE ?`, [
          cc,
          `${prefix}%`,
        ])
      }
      return true
    },
  },
  {
    name: "users.role: 'super_admin' and 'consultant' (2.0 roles)",
    run: () => ensureEnumValues('users', 'role', ['student', ...STAFF_ROLES]),
  },
  {
    name: 'initial Super Admins (INITIAL_SUPER_ADMINS in .env)',
    run: async () => {
      // Only while no Super Admin exists; after that Super Admins manage the list
      if (!env.initialSuperAdmins.length) return false
      const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'")
      if (n > 0) return false
      const [res] = await pool.query(
        `UPDATE users SET role = 'super_admin'
         WHERE LOWER(email) IN (?) AND deleted_at IS NULL`,
        [env.initialSuperAdmins]
      )
      return res.affectedRows > 0
    },
  },
  {
    name: 'users.last_active_at (last sign-in / session refresh, shown on the Team page)',
    run: () => addColumnIfMissing('users', 'last_active_at', 'DATETIME NULL'),
  },
  {
    name: 'admin_permissions.can_assign_courses / can_issue_certificates (2.0 per-person permissions)',
    run: async () => {
      const a = await addColumnIfMissing('admin_permissions', 'can_assign_courses', 'TINYINT(1) NOT NULL DEFAULT 0')
      const b = await addColumnIfMissing('admin_permissions', 'can_issue_certificates', 'TINYINT(1) NOT NULL DEFAULT 0')
      // Keep what sub-admins could already do: assigning needed "manage students",
      // and issuing certificates needed no permission at all
      if (a) await pool.query('UPDATE admin_permissions SET can_assign_courses = can_manage_students')
      if (b) await pool.query('UPDATE admin_permissions SET can_issue_certificates = 1')
      return a || b
    },
  },
  {
    name: 'consultant_settings table (lead allocation: pause, leave, limits)',
    run: async () => {
      if (await tableExists('consultant_settings')) return false
      await pool.query(`
        CREATE TABLE consultant_settings (
          user_id         INT PRIMARY KEY,
          accepting_leads TINYINT(1) NOT NULL DEFAULT 1,
          paused_reason   VARCHAR(255) NULL,
          on_leave_until  DATE NULL,
          daily_limit     INT NULL,
          open_limit      INT NULL,
          updated_by      INT NULL,
          updated_at      DATETIME NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'leads table (2.0 CRM: one row per prospect)',
    run: async () => {
      if (await tableExists('leads')) return false
      await pool.query(`
        CREATE TABLE leads (
          id                INT AUTO_INCREMENT PRIMARY KEY,
          name              VARCHAR(150) NOT NULL,
          phone             VARCHAR(30)  NULL,
          phone_norm        VARCHAR(20)  NULL,
          email             VARCHAR(150) NULL,
          email_norm        VARCHAR(150) NULL,
          course_id         INT NULL,
          preferred_schedule VARCHAR(150) NULL,
          source            VARCHAR(20)  NOT NULL DEFAULT 'manual',
          source_meta       JSON NULL,
          platform_lead_id  VARCHAR(100) NULL,
          consent           JSON NULL,
          owner_id          INT NULL,
          assigned_by       INT NULL,
          assigned_at       DATETIME NULL,
          stage             VARCHAR(30)  NOT NULL DEFAULT 'new',
          prior_stage       VARCHAR(30)  NULL,
          stage_reason      VARCHAR(255) NULL,
          stage_changed_at  DATETIME NULL,
          disposition_reason VARCHAR(255) NULL,
          next_follow_up_at DATETIME NULL,
          first_contact_at  DATETIME NULL,
          user_id           INT NULL,
          created_by        INT NULL,
          created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at        DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
          archived_at       DATETIME NULL,
          INDEX idx_leads_owner_stage (owner_id, stage),
          INDEX idx_leads_stage (stage, created_at),
          INDEX idx_leads_phone (phone_norm),
          INDEX idx_leads_email (email_norm),
          INDEX idx_leads_followup (next_follow_up_at),
          INDEX idx_leads_user (user_id),
          UNIQUE KEY uq_leads_platform (source, platform_lead_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'lead_activities table (append-only lead timeline)',
    run: async () => {
      if (await tableExists('lead_activities')) return false
      await pool.query(`
        CREATE TABLE lead_activities (
          id         BIGINT AUTO_INCREMENT PRIMARY KEY,
          lead_id    INT NOT NULL,
          actor_id   INT NULL,
          type       VARCHAR(30) NOT NULL,
          body       TEXT NULL,
          meta       JSON NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_la_lead (lead_id, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'lead_follow_ups table (scheduled calls, demos, reminders)',
    run: async () => {
      if (await tableExists('lead_follow_ups')) return false
      await pool.query(`
        CREATE TABLE lead_follow_ups (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          lead_id      INT NOT NULL,
          owner_id     INT NULL,
          due_at       DATETIME NOT NULL,
          type         VARCHAR(20) NOT NULL DEFAULT 'call',
          note         VARCHAR(500) NULL,
          status       VARCHAR(20) NOT NULL DEFAULT 'pending',
          outcome      VARCHAR(500) NULL,
          completed_at DATETIME NULL,
          created_by   INT NULL,
          created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_fu_owner_due (owner_id, status, due_at),
          INDEX idx_fu_lead (lead_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'distribution_pools + members (Round Robin routing pools, with rotation cursor)',
    run: async () => {
      if (await tableExists('distribution_pools')) return false
      await pool.query(`
        CREATE TABLE distribution_pools (
          id             INT AUTO_INCREMENT PRIMARY KEY,
          name           VARCHAR(100) NOT NULL,
          is_default     TINYINT(1) NOT NULL DEFAULT 0,
          enabled        TINYINT(1) NOT NULL DEFAULT 1,
          rules          JSON NULL,
          priority       INT NOT NULL DEFAULT 100,
          cursor_user_id INT NULL,
          created_by     INT NULL,
          created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at     DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS distribution_pool_members (
          pool_id  INT NOT NULL,
          user_id  INT NOT NULL,
          position INT NOT NULL DEFAULT 0,
          added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (pool_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      // The default pool: every active consultant, in a stable order
      await pool.query(`INSERT INTO distribution_pools (name, is_default, enabled, priority) VALUES ('All consultants', 1, 1, 1000)`)
      return true
    },
  },
  {
    name: 'crm_settings table (Round Robin on/off and other CRM switches)',
    run: async () => {
      if (await tableExists('crm_settings')) return false
      await pool.query(`
        CREATE TABLE crm_settings (
          setting    VARCHAR(64) PRIMARY KEY,
          value      VARCHAR(255) NOT NULL,
          updated_by INT NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      // Off until an Admin turns it on (leads wait in the unassigned queue)
      await pool.query(`INSERT INTO crm_settings (setting, value) VALUES ('round_robin_enabled', '0')`)
      return true
    },
  },
  {
    // Own table: some databases already have an older, unrelated "notifications" table
    name: 'user_notifications table (in-app: new lead assigned, leads waiting…)',
    run: async () => {
      if (await tableExists('user_notifications')) return false
      await pool.query(`
        CREATE TABLE user_notifications (
          id         BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id    INT NOT NULL,
          type       VARCHAR(40) NOT NULL,
          title      VARCHAR(200) NOT NULL,
          body       VARCHAR(500) NULL,
          link       VARCHAR(255) NULL,
          read_at    DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_notif_user (user_id, read_at, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'payments.lead_id / attributed_to / attributed_at (sale credited to the lead owner at sale time)',
    run: async () => {
      const a = await addColumnIfMissing('payments', 'lead_id', 'INT NULL')
      const b = await addColumnIfMissing('payments', 'attributed_to', 'INT NULL')
      const c = await addColumnIfMissing('payments', 'attributed_at', 'DATETIME NULL')
      if (b) await pool.query('CREATE INDEX idx_pay_attr ON payments (attributed_to, status, created_at)')
      return a || b || c
    },
  },
  {
    name: 'discount_links.lead_id / click tracking / revocation',
    run: async () => {
      const a = await addColumnIfMissing('discount_links', 'lead_id', 'INT NULL')
      const b = await addColumnIfMissing('discount_links', 'click_count', 'INT NOT NULL DEFAULT 0')
      const c = await addColumnIfMissing('discount_links', 'first_clicked_at', 'DATETIME NULL')
      const d = await addColumnIfMissing('discount_links', 'revoked_at', 'DATETIME NULL')
      const e = await addColumnIfMissing('discount_links', 'revoked_by', 'INT NULL')
      const f = await addColumnIfMissing('discount_links', 'revoke_reason', 'VARCHAR(255) NULL')
      return a || b || c || d || e || f
    },
  },
  {
    name: 'enrollments.lead_id (course assigned from a CRM lead)',
    run: () => addColumnIfMissing('enrollments', 'lead_id', 'INT NULL'),
  },
  {
    name: 'certificates.issued_by / lead_id / override_reason (who issued it, and any eligibility override)',
    run: async () => {
      const a = await addColumnIfMissing('certificates', 'issued_by', 'INT NULL')
      const b = await addColumnIfMissing('certificates', 'lead_id', 'INT NULL')
      const c = await addColumnIfMissing('certificates', 'override_reason', 'VARCHAR(255) NULL')
      return a || b || c
    },
  },
  {
    name: 'integrations + lead_ingest_events (Meta / LinkedIn / website lead intake)',
    run: async () => {
      if (await tableExists('lead_ingest_events')) return false
      await pool.query(`
        CREATE TABLE IF NOT EXISTS integrations (
          source          VARCHAR(20) PRIMARY KEY,
          enabled         TINYINT(1) NOT NULL DEFAULT 0,
          config          JSON NULL,
          sync_cursor     VARCHAR(100) NULL,
          last_event_at   DATETIME NULL,
          last_success_at DATETIME NULL,
          last_error_at   DATETIME NULL,
          last_error      VARCHAR(500) NULL,
          updated_by      INT NULL,
          updated_at      DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      await pool.query(
        `INSERT IGNORE INTO integrations (source, enabled) VALUES ('meta', 0), ('linkedin', 0), ('website', 1)`
      )
      await pool.query(`
        CREATE TABLE lead_ingest_events (
          id           BIGINT AUTO_INCREMENT PRIMARY KEY,
          source       VARCHAR(20) NOT NULL,
          external_id  VARCHAR(150) NOT NULL,
          status       VARCHAR(20) NOT NULL DEFAULT 'received',
          attempts     INT NOT NULL DEFAULT 0,
          error        VARCHAR(500) NULL,
          payload      JSON NULL,
          lead_id      INT NULL,
          received_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          processed_at DATETIME NULL,
          UNIQUE KEY uq_ingest (source, external_id),
          INDEX idx_ingest_status (status, received_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'whatsapp_messages + automation columns (2.0 phase 8)',
    run: async () => {
      let changed = false
      if (!(await tableExists('whatsapp_messages'))) {
        await pool.query(`
          CREATE TABLE whatsapp_messages (
            id            BIGINT AUTO_INCREMENT PRIMARY KEY,
            lead_id       INT NULL,
            direction     VARCHAR(3) NOT NULL,
            wa_id         VARCHAR(30) NOT NULL,
            wa_message_id VARCHAR(150) NULL,
            kind          VARCHAR(20) NOT NULL DEFAULT 'text',
            body          TEXT NULL,
            template      VARCHAR(100) NULL,
            status        VARCHAR(20) NOT NULL DEFAULT 'received',
            error         VARCHAR(300) NULL,
            sent_by       INT NULL,
            created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_wa_msg (wa_message_id),
            INDEX idx_wa_lead (lead_id, id),
            INDEX idx_wa_from (wa_id, direction, created_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `)
        changed = true
      }
      changed = (await addColumnIfMissing('payments', 'nudged_at', 'DATETIME NULL')) || changed
      changed = (await addColumnIfMissing('lead_follow_ups', 'reminded_at', 'DATETIME NULL')) || changed
      await pool.query("INSERT IGNORE INTO integrations (source, enabled) VALUES ('whatsapp', 0)")
      // Automations start on; Admins can switch each off (Admin → Integrations)
      await pool.query(
        `INSERT IGNORE INTO crm_settings (setting, value) VALUES
         ('auto_stage_on_payment', '1'), ('auto_course_done', '1'),
         ('abandoned_checkout_nudge', '1'), ('follow_up_reminders', '1')`
      )
      return changed
    },
  },
  {
    name: 'courses.exam_info (exam & certification section on the course page)',
    run: () => addColumnIfMissing('courses', 'exam_info', 'TEXT NULL'),
  },
  {
    name: 'courses.faqs (FAQ section on the course page, JSON [{ q, a }])',
    run: () => addColumnIfMissing('courses', 'faqs', 'JSON NULL'),
  },
  {
    name: 'integrations.sync_cursor holds one cursor per LinkedIn ad account',
    run: async () => {
      const col = await columnInfo('integrations', 'sync_cursor')
      if (!col || /text/i.test(col.COLUMN_TYPE)) return false
      await pool.query('ALTER TABLE integrations MODIFY sync_cursor TEXT NULL')
      return true
    },
  },
  {
    name: 'integration_secrets table (API keys saved from Admin → Integrations, encrypted)',
    run: async () => {
      if (await tableExists('integration_secrets')) return false
      await pool.query(`
        CREATE TABLE integration_secrets (
          source     VARCHAR(20) NOT NULL,
          name       VARCHAR(40) NOT NULL,
          sealed     TEXT NOT NULL,
          hint       VARCHAR(12) NULL,
          updated_by INT NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (source, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'user_permission_grants table (delegated privileges, e.g. super_admin.create)',
    run: async () => {
      if (await tableExists('user_permission_grants')) return false
      // No foreign keys to users(id): the live users.id type differs from the schema file
      await pool.query(`
        CREATE TABLE user_permission_grants (
          id             INT AUTO_INCREMENT PRIMARY KEY,
          user_id        INT NOT NULL,
          permission_key VARCHAR(64) NOT NULL,
          granted_by     INT NOT NULL,
          granted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revoked_by     INT NULL,
          revoked_at     DATETIME NULL,
          INDEX idx_upg_user (user_id, permission_key, revoked_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'leads: exam coordinator, exam schedule / completion, ticket size',
    run: async () => {
      const added = [
        await addColumnIfMissing('leads', 'exam_coordinator_id', 'INT NULL'),
        await addColumnIfMissing('leads', 'exam_coordinator_assigned_at', 'DATETIME NULL'),
        await addColumnIfMissing('leads', 'exam_status', "VARCHAR(20) NOT NULL DEFAULT 'not_scheduled'"),
        await addColumnIfMissing('leads', 'exam_scheduled_at', 'DATETIME NULL'),
        await addColumnIfMissing('leads', 'exam_completed_at', 'DATETIME NULL'),
        await addColumnIfMissing('leads', 'exam_result', 'VARCHAR(10) NULL'),
        await addColumnIfMissing('leads', 'exam_note', 'VARCHAR(255) NULL'),
        await addColumnIfMissing('leads', 'ticket_size', 'DECIMAL(12,2) NULL'),
        await addColumnIfMissing('leads', 'ticket_currency', 'CHAR(3) NULL'),
      ]
      if (added[0]) await pool.query('CREATE INDEX idx_leads_exam_coord ON leads (exam_coordinator_id, exam_status)')
      if (added[2]) await pool.query('CREATE INDEX idx_leads_exam ON leads (exam_status, exam_completed_at)')
      return added.some(Boolean)
    },
  },
  {
    name: 'consultant_settings.on_leave_from (plan leave ahead: from – until)',
    run: () => addColumnIfMissing('consultant_settings', 'on_leave_from', 'DATE NULL'),
  },
  {
    name: 'leads: application submitted, exam done, payment status (+ move existing data)',
    run: async () => {
      const added = [
        await addColumnIfMissing('leads', 'application_submitted', 'TINYINT(1) NOT NULL DEFAULT 0'),
        await addColumnIfMissing('leads', 'application_submitted_at', 'DATE NULL'),
        await addColumnIfMissing('leads', 'exam_done', 'TINYINT(1) NOT NULL DEFAULT 0'),
        await addColumnIfMissing('leads', 'payment_status', "VARCHAR(10) NOT NULL DEFAULT 'due'"),
        await addColumnIfMissing('leads', 'payment_done_at', 'DATETIME NULL'),
        await addColumnIfMissing('leads', 'payment_reference', 'VARCHAR(255) NULL'),
        await addColumnIfMissing('leads', 'payment_marked_by', 'INT NULL'),
      ]
      if (added[2]) {
        // Old "completed" exams → Exam Done = Yes (the schedule status stays "scheduled")
        await pool.query("UPDATE leads SET exam_done = 1, exam_status = 'scheduled' WHERE exam_status = 'completed'")
        // Applications whose exam is already scheduled or done → the new Exam Scheduled stage
        await pool.query(
          "UPDATE leads SET stage = 'exam_scheduled' WHERE stage = 'application' AND (exam_status = 'scheduled' OR exam_done = 1)"
        )
        await pool.query('CREATE INDEX idx_leads_payment ON leads (payment_status, exam_done)')
      }
      if (added[3]) {
        // Leads that already paid online
        await pool.query(
          `UPDATE leads l
           JOIN (SELECT lead_id, MIN(created_at) AS paid_at FROM payments WHERE status = 'success' AND lead_id IS NOT NULL GROUP BY lead_id) p
             ON p.lead_id = l.id
           SET l.payment_status = 'done', l.payment_done_at = p.paid_at, l.payment_reference = 'Online payment'`
        )
      }
      return added.some(Boolean)
    },
  },
  {
    name: 'live_batches + batch_enrollments (live batches with enrollment → CRM lead)',
    run: async () => {
      if (await tableExists('live_batches')) return false
      await pool.query(`
        CREATE TABLE live_batches (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          title         VARCHAR(160) NOT NULL,
          course_id     INT NULL,
          trainer_name  VARCHAR(120) NULL,
          trainer_title VARCHAR(160) NULL,
          start_date    DATE NOT NULL,
          end_date      DATE NULL,
          schedule      VARCHAR(160) NULL,
          timezone      VARCHAR(40) NULL,
          mode          ENUM('online','classroom','hybrid') NOT NULL DEFAULT 'online',
          location      VARCHAR(160) NULL,
          seats         INT NULL,
          price         DECIMAL(12,2) NULL,
          currency      ENUM('INR','USD') NOT NULL DEFAULT 'INR',
          description   TEXT NULL,
          status        ENUM('draft','published','closed','cancelled') NOT NULL DEFAULT 'draft',
          created_by    INT NULL,
          created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_lb_public (status, start_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS batch_enrollments (
          id               INT AUTO_INCREMENT PRIMARY KEY,
          batch_id         INT NOT NULL,
          name             VARCHAR(150) NOT NULL,
          email            VARCHAR(150) NOT NULL,
          phone            VARCHAR(30) NOT NULL,
          phone_norm       VARCHAR(10) NULL,
          company          VARCHAR(150) NULL,
          experience_years TINYINT NULL,
          message          TEXT NULL,
          lead_id          INT NULL,
          ingest_event_id  INT NULL,
          ip               VARCHAR(64) NULL,
          user_agent       VARCHAR(200) NULL,
          created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_be_batch (batch_id, id),
          INDEX idx_be_lead (lead_id),
          CONSTRAINT fk_be_batch FOREIGN KEY (batch_id) REFERENCES live_batches(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'user_push_tokens (CERTEZY Team app push notifications)',
    run: async () => {
      if (await tableExists('user_push_tokens')) return false
      await pool.query(`
        CREATE TABLE user_push_tokens (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          user_id      INT NOT NULL,
          token        VARCHAR(200) NOT NULL,
          platform     VARCHAR(10) NOT NULL DEFAULT 'android',
          device_name  VARCHAR(120) NULL,
          created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_push_token (token),
          INDEX idx_push_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'admin_permissions: Sub-Admin feature areas (CRM, lead assignment, CRM reports, team, live batches)',
    run: async () => {
      let changed = false
      for (const col of ['can_access_crm', 'can_assign_leads', 'can_view_crm_reports', 'can_manage_team', 'can_manage_batches']) {
        changed = (await addColumnIfMissing('admin_permissions', col, 'TINYINT(1) NOT NULL DEFAULT 0')) || changed
      }
      return changed
    },
  },
  {
    name: 'admin_permissions: a permission for every admin tab and its options — Sub-Admins keep what they could do',
    run: async () => {
      // value for existing Sub-Admins: what they could already do before this change
      const cols = {
        can_view_dashboard: '1',
        can_view_consultant_progress: 'can_access_crm',
        can_view_sales: 'can_access_crm',
        can_import_leads: 'can_access_crm',
        can_view_courses: '1',
        can_view_categories: '1',
        can_manage_categories: '0', // was Admins only
        can_view_enrollments: '1',
        can_export_enrollments: '1',
        can_view_certificates: '1',
        can_view_reviews: '1',
        can_manage_reviews: '1', // approving reviews was open to every Sub-Admin
        can_bulk_import: '1',
        can_view_discounts: '1',
        can_view_contact: '1',
        can_reply_contact: '1',
      }
      const added = []
      for (const col of Object.keys(cols)) {
        if (await addColumnIfMissing('admin_permissions', col, 'TINYINT(1) NOT NULL DEFAULT 0')) added.push(col)
      }
      if (added.length) {
        await pool.query(
          `UPDATE admin_permissions p JOIN users u ON u.id = p.user_id SET ${added.map((c) => `p.${c} = ${cols[c] === '1' || cols[c] === '0' ? cols[c] : `p.${cols[c]}`}`).join(', ')}
           WHERE u.role = 'sub_admin'`
        )
      }
      return added.length > 0
    },
  },
  {
    name: 'refresh_tokens.last_activity_at (idle sign-out)',
    run: async () => {
      const added = await addColumnIfMissing('refresh_tokens', 'last_activity_at', 'DATETIME NULL')
      if (added) await pool.query('UPDATE refresh_tokens SET last_activity_at = UTC_TIMESTAMP()')
      return added
    },
  },
  {
    name: 'users.two_factor_enabled + login_challenges (email one-time codes)',
    run: async () => {
      const a = await addColumnIfMissing('users', 'two_factor_enabled', 'TINYINT(1) NOT NULL DEFAULT 0')
      const b = await addColumnIfMissing('users', 'two_factor_enabled_at', 'DATETIME NULL')
      let c = false
      if (!(await tableExists('login_challenges'))) {
        await pool.query(`
          CREATE TABLE login_challenges (
            id           VARCHAR(64) PRIMARY KEY,
            user_id      INT NOT NULL,
            purpose      VARCHAR(10) NOT NULL DEFAULT 'login',
            code_hash    CHAR(64) NOT NULL,
            attempts     TINYINT NOT NULL DEFAULT 0,
            sends        TINYINT NOT NULL DEFAULT 1,
            expires_at   DATETIME NOT NULL,
            last_sent_at DATETIME NOT NULL,
            created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_lc_user (user_id, purpose)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `)
        c = true
      }
      return a || b || c
    },
  },
  {
    name: 'refresh_tokens.client (CERTEZY Team app sessions stay signed in)',
    run: () => addColumnIfMissing('refresh_tokens', 'client', 'VARCHAR(10) NULL'),
  },
  {
    name: 'refresh_tokens.prev_token (Team app: a renewal lost on a bad network does not sign out)',
    run: async () => {
      const added = await addColumnIfMissing('refresh_tokens', 'prev_token', 'VARCHAR(512) NULL')
      if (added) await pool.query('CREATE INDEX idx_rt_prev_token ON refresh_tokens (prev_token)')
      return added
    },
  },
  {
    name: 'leads.whatsapp_number (consultant-added WhatsApp; the source phone stays as fetched)',
    run: () => addColumnIfMissing('leads', 'whatsapp_number', 'VARCHAR(30) NULL'),
  },
  {
    name: 'leads.owner_seen_at (red dot on leads the owner has not opened yet)',
    run: async () => {
      const added = await addColumnIfMissing('leads', 'owner_seen_at', 'DATETIME NULL')
      // Leads that exist today count as seen; only new assignments get the dot
      if (added) await pool.query('UPDATE leads SET owner_seen_at = UTC_TIMESTAMP() WHERE owner_id IS NOT NULL')
      return added
    },
  },
  {
    name: 'message_templates (consultants\' WhatsApp / email messages for leads)',
    run: async () => {
      if (await tableExists('message_templates')) return false
      await pool.query(`
        CREATE TABLE message_templates (
          id         INT AUTO_INCREMENT PRIMARY KEY,
          user_id    INT NULL,
          channel    VARCHAR(10) NOT NULL,
          title      VARCHAR(80) NOT NULL,
          subject    VARCHAR(150) NULL,
          body       TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_mt_user (user_id, channel)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'payments.gateway_order_id (a gateway receipt can only confirm its own payment)',
    run: async () => {
      const added = await addColumnIfMissing('payments', 'gateway_order_id', 'VARCHAR(100) NULL')
      if (added) await pool.query('CREATE INDEX idx_pay_gw_order ON payments (gateway_order_id)')
      return added
    },
  },
  {
    name: 'audit_logs table (append-only record of sensitive actions)',
    run: async () => {
      if (await tableExists('audit_logs')) return false
      await pool.query(`
        CREATE TABLE audit_logs (
          id          BIGINT AUTO_INCREMENT PRIMARY KEY,
          actor_id    INT NULL,
          actor_role  VARCHAR(20) NULL,
          action      VARCHAR(64) NOT NULL,
          target_type VARCHAR(32) NULL,
          target_id   INT NULL,
          result      ENUM('success','denied','failed') NOT NULL DEFAULT 'success',
          details     JSON NULL,
          ip          VARCHAR(64) NULL,
          user_agent  VARCHAR(255) NULL,
          created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_audit_created (created_at),
          INDEX idx_audit_action (action, created_at),
          INDEX idx_audit_target (target_type, target_id),
          INDEX idx_audit_actor (actor_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'lead_call_recordings (lead call recordings from the Team app, private in S3; Super Admins only)',
    run: async () => {
      if (await tableExists('lead_call_recordings')) return false
      await pool.query(`
        CREATE TABLE lead_call_recordings (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          lead_id      INT NOT NULL,
          user_id      INT NOT NULL,
          call_at      DATETIME NOT NULL,
          direction    VARCHAR(20) NULL,
          duration_sec INT NOT NULL DEFAULT 0,
          file_name    VARCHAR(255) NOT NULL,
          size_bytes   BIGINT NOT NULL,
          mime         VARCHAR(80) NOT NULL,
          s3_key       VARCHAR(400) NOT NULL,
          status       VARCHAR(20) NOT NULL DEFAULT 'pending',
          uploaded_at  DATETIME NULL,
          deleted_at   DATETIME NULL,
          deleted_by   INT NULL,
          created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_rec_file (user_id, file_name(150), size_bytes),
          INDEX idx_rec_call (call_at),
          INDEX idx_rec_lead (lead_id),
          INDEX idx_rec_user (user_id, call_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
  },
  {
    name: 'db_backups (daily database backups in S3; newest 7 kept)',
    run: async () => {
      if (await tableExists('db_backups')) return false
      await pool.query(`
        CREATE TABLE db_backups (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          s3_key       VARCHAR(300) NOT NULL,
          status       VARCHAR(20) NOT NULL DEFAULT 'running',
          trigger_type VARCHAR(20) NOT NULL DEFAULT 'scheduled',
          triggered_by INT NULL,
          size_bytes   BIGINT NULL,
          tables_count INT NULL,
          rows_count   BIGINT NULL,
          duration_ms  INT NULL,
          error        VARCHAR(500) NULL,
          started_at   DATETIME NOT NULL,
          finished_at  DATETIME NULL,
          deleted_at   DATETIME NULL,
          INDEX idx_backup_status (status, started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `)
      return true
    },
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
