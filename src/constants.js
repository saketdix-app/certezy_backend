// src/constants.js
// Enumerations shared by validation, migrations, CSV import and services.

// Lesson content types.
//   video   — S3 key/URL, MP4/WebM URL, YouTube or Vimeo link
//   text    — rich text / HTML written in the admin (alias: article)
//   pdf     — PDF stored on S3 or any public PDF URL
//   link    — external resource opened in a new tab (docs, labs, blog posts)
//   embed   — any iframe-able URL (Google Slides/Docs, Loom, Figma, CodePen…)
//   audio   — MP3/M4A/OGG URL (podcast-style lessons)
//   quiz    — points to a practice test of the course
export const LESSON_TYPES = ['video', 'text', 'article', 'pdf', 'link', 'embed', 'audio', 'quiz']

export const COURSE_LEVELS = ['beginner', 'intermediate', 'advanced']
export const COURSE_STATUSES = ['draft', 'published', 'archived']
export const PRICING_TYPES = ['free', 'paid']

export const TEST_TYPES = ['practice', 'mock', 'diagnostic', 'final']
export const QUESTION_TYPES = ['single', 'multiple', 'true_false']
export const DIFFICULTIES = ['easy', 'medium', 'hard']

// Who can use learner features (enroll, buy, learn, take tests, review).
// Admins and sub-admins can too, so they can try every part of the site.
export const LEARNER_ROLES = ['student', 'super_admin', 'admin', 'sub_admin']

// ── 2.0 roles & privileges (PRD §1–3) ────────────────────────────────────
// Staff roles, most powerful first. 'consultant' is the sales team (CRM, phase 3).
export const STAFF_ROLES = ['super_admin', 'admin', 'sub_admin', 'consultant']

// Delegated privileges a Super Admin can grant to an Admin. Recorded in
// user_permission_grants with grantor, time and revocation (PRD §2.1).
export const PRIVILEGES = {
  CREATE_SUPER_ADMIN: 'super_admin.create',
}

// Enrollment.source values
export const ENROLLMENT_SOURCES = { PURCHASE: 'purchase', ADMIN: 'admin', FREE: 'free' }

// Where a review came from. 'platform' = written by an enrolled student on the
// site; the others are genuine reviews an admin entered on a learner's behalf
// (shown publicly with this label).
export const REVIEW_SOURCES = {
  platform: 'Verified CERTEZY learner',
  classroom: 'Classroom / live batch',
  corporate: 'Corporate training',
  other_platform: 'Another platform',
  feedback_form: 'Feedback form / email',
}
export const ADMIN_REVIEW_SOURCES = Object.keys(REVIEW_SOURCES).filter((s) => s !== 'platform')
