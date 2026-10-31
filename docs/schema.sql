-- Certezy — baseline database schema (MySQL 8.0+, utf8mb4)
--
-- Fresh install:   mysql -u root -p certezy < docs/schema.sql
-- Existing DB:     nothing to run — newer columns/tables are added automatically
--                  at API startup by src/config/migrate.js (idempotent).
--
-- This file was reconstructed from the queries the API runs, so it matches what
-- the code expects. Keep it in sync when adding tables or columns.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  email           VARCHAR(150) NOT NULL UNIQUE,
  password        VARCHAR(255) NULL,
  role            ENUM('student','sub_admin','admin') NOT NULL DEFAULT 'student',
  gender          VARCHAR(20)  NULL,
  mobile          VARCHAR(20)  NULL,
  avatar          VARCHAR(500) NULL,
  oauth_provider  VARCHAR(20)  NOT NULL DEFAULT 'local',
  oauth_id        VARCHAR(100) NULL,
  is_verified     TINYINT(1)   NOT NULL DEFAULT 0,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  is_first_login  TINYINT(1)   NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  token       VARCHAR(512) NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rt_token (token(191)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL,
  provider     VARCHAR(20)  NOT NULL,
  provider_id  VARCHAR(100) NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_oauth (provider, provider_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_permissions (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  user_id              INT NOT NULL UNIQUE,
  can_manage_courses   TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_students  TINYINT(1) NOT NULL DEFAULT 0,
  can_send_discounts   TINYINT(1) NOT NULL DEFAULT 0,
  can_view_payments    TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_tests     TINYINT(1) NOT NULL DEFAULT 0,
  created_by           INT NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS categories (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  slug         VARCHAR(120) NOT NULL UNIQUE,
  description  TEXT NULL,
  icon         VARCHAR(255) NULL,
  parent_id    INT NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS courses (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  title                 VARCHAR(200) NOT NULL,
  slug                  VARCHAR(220) NOT NULL UNIQUE,
  description           TEXT NULL,
  short_desc            VARCHAR(500) NULL,
  category_id           INT NOT NULL,
  thumbnail             VARCHAR(500) NULL,
  preview_video         VARCHAR(500) NULL,
  price                 DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  original_price        DECIMAL(10,2) NULL,                 -- list price shown struck-through when discounted
  pricing_type          ENUM('free','paid') NOT NULL DEFAULT 'paid',
  level                 ENUM('beginner','intermediate','advanced') NOT NULL DEFAULT 'beginner',
  language              VARCHAR(50) NOT NULL DEFAULT 'English',
  status                ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  is_featured           TINYINT(1) NOT NULL DEFAULT 0,
  requirements          TEXT NULL,
  what_you_learn        TEXT NULL,
  certificate_eligible  TINYINT(1) NOT NULL DEFAULT 1,
  total_duration        INT NOT NULL DEFAULT 0,      -- seconds, sum of lesson durations
  total_lessons         INT NOT NULL DEFAULT 0,
  enrolled_count        INT NOT NULL DEFAULT 0,
  rating_avg            DECIMAL(2,1) NOT NULL DEFAULT 0.0,
  rating_count          INT NOT NULL DEFAULT 0,
  created_by            INT NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_courses_status (status),
  FULLTEXT KEY ft_courses (title, description, short_desc),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sections (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  course_id   INT NOT NULL,
  title       VARCHAR(200) NOT NULL,
  order_num   INT NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lessons (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  section_id  INT NOT NULL,
  title       VARCHAR(200) NOT NULL,
  type        ENUM('video','text','article','pdf','link','quiz') NOT NULL DEFAULT 'video',
  content     MEDIUMTEXT NULL,      -- video URL, S3 key/URL, external link or rich text
  duration    INT NOT NULL DEFAULT 0, -- seconds (admin enters minutes)
  order_num   INT NOT NULL DEFAULT 1,
  is_free     TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lesson_progress (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  lesson_id     INT NOT NULL,
  is_completed  TINYINT(1) NOT NULL DEFAULT 0,
  watch_time    INT NOT NULL DEFAULT 0,
  last_watched  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_progress (user_id, lesson_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tests (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  course_id        INT NOT NULL,
  lesson_id        INT NULL,
  title            VARCHAR(200) NOT NULL,
  type             ENUM('practice','mock','diagnostic','final') NOT NULL DEFAULT 'practice',
  duration         INT NOT NULL DEFAULT 60,
  total_questions  INT NOT NULL DEFAULT 0,
  pass_percentage  INT NOT NULL DEFAULT 70,
  status           ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS questions (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  test_id      INT NOT NULL,
  question     TEXT NOT NULL,
  type         ENUM('single','multiple','true_false') NOT NULL DEFAULT 'single',
  explanation  TEXT NULL,
  difficulty   ENUM('easy','medium','hard') NOT NULL DEFAULT 'medium',
  topic_tag    VARCHAR(100) NULL,
  order_num    INT NOT NULL DEFAULT 1,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS options (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  question_id  INT NOT NULL,
  option_text  TEXT NOT NULL,
  is_correct   TINYINT(1) NOT NULL DEFAULT 0,
  order_num    INT NOT NULL DEFAULT 0,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS test_attempts (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  test_id         INT NOT NULL,
  attempt_number  INT NOT NULL DEFAULT 1,
  score           DECIMAL(5,2) NULL,
  total_marks     INT NULL,
  obtained_marks  INT NULL,
  time_taken      INT NULL,
  is_passed       TINYINT(1) NULL,
  started_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    TIMESTAMP NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attempt_answers (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  attempt_id     INT NOT NULL,
  question_id    INT NOT NULL,
  selected_opts  JSON NULL,
  is_correct     TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (attempt_id) REFERENCES test_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS discount_links (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  token           VARCHAR(100) NOT NULL UNIQUE,
  user_id         INT NULL,                -- NULL until someone with `email` signs up
  email           VARCHAR(150) NULL,       -- set for discounts sent to an email address
  course_id       INT NOT NULL,
  original_price  DECIMAL(10,2) NOT NULL,
  discount_price  DECIMAL(10,2) NOT NULL,
  discount_pct    DECIMAL(5,2) NULL,
  is_used         TINYINT(1) NOT NULL DEFAULT 0,
  created_by      INT NOT NULL,
  expires_at      DATETIME NOT NULL,
  used_at         DATETIME NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT NOT NULL,
  course_id         INT NULL,
  amount            DECIMAL(10,2) NOT NULL,
  original_amount   DECIMAL(10,2) NULL,
  currency          VARCHAR(10) NOT NULL DEFAULT 'USD',
  method            VARCHAR(30) NOT NULL,
  gateway_txn_id    VARCHAR(255) NULL,
  discount_link_id  INT NULL,
  status            ENUM('pending','success','failed','refunded') NOT NULL DEFAULT 'pending',
  invoice_url       VARCHAR(500) NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pay_txn (gateway_txn_id(191)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS enrollments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  course_id     INT NOT NULL,
  payment_id    INT NULL,
  source        VARCHAR(20) NOT NULL DEFAULT 'purchase', -- purchase | admin | free
  assigned_by   INT NULL,
  note          VARCHAR(255) NULL,
  progress      INT NOT NULL DEFAULT 0,
  enrolled_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  TIMESTAMP NULL,
  UNIQUE KEY uq_enrollment (user_id, course_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS certificates (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  course_id       INT NOT NULL,
  certificate_no  VARCHAR(50) NOT NULL UNIQUE,
  issued_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until     DATETIME NULL,
  pdf_url         VARCHAR(500) NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviews (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT NULL,                               -- NULL for reviews entered by an admin
  course_id      INT NOT NULL,
  rating         TINYINT NOT NULL,
  comment        TEXT NULL,
  is_approved    TINYINT(1) NOT NULL DEFAULT 0,
  source         VARCHAR(20) NOT NULL DEFAULT 'platform', -- see REVIEW_SOURCES in src/constants.js
  reviewer_name  VARCHAR(100) NULL,
  source_note    VARCHAR(255) NULL,
  reviewed_at    DATE NULL,
  created_by     INT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_review (user_id, course_id),
  INDEX idx_reviews_course (course_id, is_approved),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contacts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NULL,
  name        VARCHAR(150) NOT NULL,
  email       VARCHAR(255) NOT NULL,
  phone       VARCHAR(30)  NULL,
  subject     VARCHAR(200) NOT NULL,
  message     TEXT         NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'new',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_contacts_status (status),
  INDEX idx_contacts_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
