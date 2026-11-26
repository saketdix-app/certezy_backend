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
// 'exam_coordinator' works with students on the leads assigned to them to
// schedule and complete the exam; the lead stays owned by its consultant.
export const STAFF_ROLES = ['super_admin', 'admin', 'sub_admin', 'consultant', 'exam_coordinator']

// Delegated privileges a Super Admin can grant to an Admin. Recorded in
// user_permission_grants with grantor, time and revocation (PRD §2.1).
export const PRIVILEGES = {
  CREATE_SUPER_ADMIN: 'super_admin.create',
}

// Per-person permissions for Sub-Admins and Consultants (admin_permissions
// columns). Super Admins and Admins have all of them. PRD §3 "Yes*" items.
export const STAFF_PERMISSIONS = [
  'can_assign_courses',
  'can_send_discounts',
  'can_issue_certificates',
  'can_manage_students',
  'can_view_payments',
  'can_manage_courses',
  'can_manage_tests',
  // Sub-Admin tabs and options (Team → Permissions)
  'can_view_dashboard',
  'can_access_crm', // CRM: Leads and Follow-ups — work every lead like an Admin (needed for the CRM tabs below)
  'can_view_consultant_progress', // CRM: By consultant
  'can_view_sales', // CRM: Sales (revenue stays Super Admin only)
  'can_import_leads', // CRM: Import leads from a CSV
  'can_assign_leads', // CRM: Distribution, assign / transfer leads, hand over
  'can_view_crm_reports', // CRM Reports (works without lead access; revenue stays Super Admin only)
  'can_view_courses',
  'can_view_categories',
  'can_manage_categories',
  'can_view_enrollments',
  'can_export_enrollments',
  'can_view_certificates',
  'can_view_reviews',
  'can_manage_reviews',
  'can_bulk_import',
  'can_view_discounts',
  'can_view_contact',
  'can_reply_contact',
  'can_manage_team', // Team: add and manage Consultants and Exam Coordinators
  'can_manage_batches', // Live batches and their enrollments
]

// Consultants can only get these (used from a lead: assign a course, send a discount link, issue a certificate)
export const CONSULTANT_PERMISSIONS = ['can_assign_courses', 'can_send_discounts', 'can_issue_certificates']
// Everything else is for Sub-Admins only
export const SUB_ADMIN_ONLY_PERMISSIONS = STAFF_PERMISSIONS.filter((k) => !CONSULTANT_PERMISSIONS.includes(k) && k !== 'can_manage_students' && k !== 'can_view_payments' && k !== 'can_manage_courses' && k !== 'can_manage_tests')

/**
 * Team → Permissions for Sub-Admins: every admin tab, by menu section. `open`
 * shows the tab; `options` are what they can do inside it (only with `open`).
 * `needs`: another permission the tab works on top of. `locked`: only Admins /
 * Super Admins, shown so it's clear. The website builds the screen from this.
 */
export const PERMISSION_CATALOG = [
  { key: 'overview', label: 'Overview', tabs: [{ label: 'Dashboard', open: 'can_view_dashboard' }] },
  {
    key: 'crm',
    label: 'CRM',
    tabs: [
      { label: 'Leads & Follow-ups', open: 'can_access_crm', options: ['can_import_leads'] },
      { label: 'By consultant', open: 'can_view_consultant_progress', needs: 'can_access_crm' },
      { label: 'Distribution', open: 'can_assign_leads', needs: 'can_access_crm' },
      { label: 'Sales', open: 'can_view_sales', needs: 'can_access_crm' },
      { label: 'CRM Reports', open: 'can_view_crm_reports' },
      { label: 'Call recordings', locked: 'Super Admins only' },
    ],
  },
  {
    key: 'learning',
    label: 'Learning',
    tabs: [
      { label: 'Courses', open: 'can_view_courses', options: ['can_manage_courses', 'can_manage_tests'] },
      { label: 'Categories', open: 'can_view_categories', options: ['can_manage_categories'] },
      { label: 'Enrollments', open: 'can_view_enrollments', options: ['can_export_enrollments'] },
      { label: 'Assign Courses', open: 'can_assign_courses' },
      { label: 'Live batches', open: 'can_manage_batches' },
      { label: 'Certificates', open: 'can_view_certificates', options: ['can_issue_certificates'] },
      { label: 'Reviews', open: 'can_view_reviews', options: ['can_manage_reviews'] },
      { label: 'Bulk Import', open: 'can_bulk_import', note: 'Courses need "Create and edit courses"; quizzes need "Tests and quizzes"' },
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    tabs: [
      { label: 'Payments', open: 'can_view_payments' },
      { label: 'Discounts', open: 'can_view_discounts', options: ['can_send_discounts'] },
      { label: 'Lead discount links', open: 'can_access_crm', shared: true },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    tabs: [
      { label: 'Users', open: 'can_manage_students' },
      { label: 'Team', open: 'can_manage_team' },
      { label: 'Contact messages', open: 'can_view_contact', options: ['can_reply_contact'] },
      { label: 'Integrations', locked: 'Admins only' },
    ],
  },
]

// Idle sign-out: a session with no activity for this long ends (minutes)
export const IDLE_MINUTES = { super_admin: 30, default: 60 }
// CERTEZY Team app: stays signed in like other phone apps — no idle sign-out
// (except Super Admins), and the session renews itself for this many days
export const MOBILE_SESSION_DAYS = 90

// Starting permissions when someone becomes a Sub-Admin or Consultant (PRD §3 matrix)
export const DEFAULT_PERMISSIONS = {
  sub_admin: [
    'can_view_dashboard',
    'can_view_courses',
    'can_view_categories',
    'can_view_enrollments',
    'can_view_certificates',
    'can_assign_courses',
    'can_view_discounts',
    'can_send_discounts',
    'can_issue_certificates',
    'can_manage_students',
  ],
  consultant: ['can_assign_courses', 'can_send_discounts', 'can_issue_certificates'],
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
