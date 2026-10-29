// src/modules/imports/imports.templates.js
// Column definitions for every CSV the admin can import, plus the sample rows
// served as downloadable templates (Admin → Bulk Import → "Download sample").
//
// Conventions used in every template
//   * first row = header, names are case-insensitive, extra columns ignored
//   * yes/no columns accept yes|no|true|false|1|0
//   * list columns (what_you_learn, requirements) use " | " between items
//   * rows are matched to existing records, so re-importing updates instead
//     of duplicating: courses by slug, sections/lessons/quizzes by title
//     within their parent, questions by question text within the quiz

export const TEMPLATES = {
  courses: {
    label: 'Courses',
    description: 'Create or update courses (title, category, pricing, media, level…).',
    columns: [
      { name: 'title', required: true, help: 'Course title (3–200 chars)' },
      { name: 'slug', help: 'URL id; generated from title when empty. Existing slug = update.' },
      { name: 'category', required: true, help: 'Category name or slug (created if missing)' },
      { name: 'short_desc', help: 'One-line summary (≤ 500 chars)' },
      { name: 'description', help: 'Full description (plain text or HTML)' },
      { name: 'pricing_type', help: 'free | paid (default: paid when price > 0)' },
      { name: 'price', help: 'Selling price in USD (paid courses)' },
      { name: 'original_price', help: 'Optional list price; shown struck-through when higher than price' },
      { name: 'level', help: 'beginner | intermediate | advanced' },
      { name: 'language', help: 'Default: English' },
      { name: 'status', help: 'draft | published | archived (default: draft)' },
      { name: 'is_featured', help: 'yes | no' },
      { name: 'certificate_eligible', help: 'yes | no (default: yes)' },
      { name: 'thumbnail', help: 'Image URL — 16:9 (1280×720) recommended' },
      { name: 'preview_video', help: 'Video URL (YouTube, Vimeo, MP4…)' },
      { name: 'what_you_learn', help: 'Items separated by |' },
      { name: 'requirements', help: 'Items separated by |' },
    ],
    sample: [
      {
        title: 'Introduction to Cloud Computing',
        slug: 'intro-cloud-computing',
        category: 'Cloud Computing',
        short_desc: 'Understand cloud models, services and pricing in plain language.',
        description: 'A beginner-friendly tour of IaaS, PaaS, SaaS and the major cloud providers.',
        pricing_type: 'free',
        price: '0',
        original_price: '',
        level: 'beginner',
        language: 'English',
        status: 'draft',
        is_featured: 'no',
        certificate_eligible: 'yes',
        thumbnail: '',
        preview_video: 'https://www.youtube.com/watch?v=VIDEO_ID',
        what_you_learn: 'Explain IaaS vs PaaS vs SaaS | Compare public, private and hybrid cloud',
        requirements: 'Basic computer literacy',
      },
      {
        title: 'Project Management Professional (PMP) Exam Prep',
        slug: 'pmp-exam-prep',
        category: 'Project Management',
        short_desc: 'Complete preparation for the PMP certification exam.',
        description: 'Covers People, Process and Business Environment domains with practice exams.',
        pricing_type: 'paid',
        price: '149',
        original_price: '199',
        level: 'intermediate',
        language: 'English',
        status: 'draft',
        is_featured: 'yes',
        certificate_eligible: 'yes',
        thumbnail: 'https://example.com/images/pmp.jpg',
        preview_video: '',
        what_you_learn: 'Apply predictive, agile and hybrid approaches | Earn 35 contact hours',
        requirements: 'Project experience as required by PMI',
      },
    ],
  },

  curriculum: {
    label: 'Sections & Lessons',
    description: 'Build a course curriculum: one row per lesson, grouped into sections.',
    columns: [
      { name: 'course_slug', required: true, help: 'Slug of an existing course (import courses first)' },
      { name: 'section_title', required: true, help: 'Section / module name' },
      { name: 'section_order', help: 'Number; defaults to order of first appearance' },
      { name: 'lesson_title', required: true, help: 'Lesson name' },
      {
        name: 'lesson_type',
        required: true,
        help: 'video | text | pdf | link | embed | audio | quiz',
      },
      {
        name: 'content',
        help: 'video/pdf/audio: URL or S3 key · link/embed: URL · text: text/HTML · quiz: quiz title',
      },
      { name: 'duration_minutes', help: 'Whole minutes (default 0)' },
      { name: 'is_free_preview', help: 'yes | no — visible without enrolling' },
      { name: 'lesson_order', help: 'Number; defaults to row order inside the section' },
    ],
    sample: [
      {
        course_slug: 'intro-cloud-computing',
        section_title: 'Getting started',
        section_order: '1',
        lesson_title: 'Welcome & course overview',
        lesson_type: 'video',
        content: 'https://www.youtube.com/watch?v=VIDEO_ID',
        duration_minutes: '5',
        is_free_preview: 'yes',
        lesson_order: '1',
      },
      {
        course_slug: 'intro-cloud-computing',
        section_title: 'Getting started',
        section_order: '1',
        lesson_title: 'What is cloud computing?',
        lesson_type: 'text',
        content: '<p>Cloud computing is the on-demand delivery of IT resources over the internet…</p>',
        duration_minutes: '10',
        is_free_preview: 'no',
        lesson_order: '2',
      },
      {
        course_slug: 'intro-cloud-computing',
        section_title: 'Getting started',
        section_order: '1',
        lesson_title: 'Cloud glossary (PDF)',
        lesson_type: 'pdf',
        content: 'https://example.com/docs/cloud-glossary.pdf',
        duration_minutes: '10',
        is_free_preview: 'no',
        lesson_order: '3',
      },
      {
        course_slug: 'intro-cloud-computing',
        section_title: 'Going further',
        section_order: '2',
        lesson_title: 'Official documentation',
        lesson_type: 'link',
        content: 'https://docs.aws.amazon.com/',
        duration_minutes: '15',
        is_free_preview: 'no',
        lesson_order: '1',
      },
      {
        course_slug: 'intro-cloud-computing',
        section_title: 'Going further',
        section_order: '2',
        lesson_title: 'Slides',
        lesson_type: 'embed',
        content: 'https://docs.google.com/presentation/d/PRESENTATION_ID/embed',
        duration_minutes: '10',
        is_free_preview: 'no',
        lesson_order: '2',
      },
      {
        course_slug: 'intro-cloud-computing',
        section_title: 'Going further',
        section_order: '2',
        lesson_title: 'Module quiz',
        lesson_type: 'quiz',
        content: 'Cloud Basics Quiz',
        duration_minutes: '15',
        is_free_preview: 'no',
        lesson_order: '3',
      },
    ],
  },

  quizzes: {
    label: 'Quizzes & Questions',
    description: 'Practice tests with single-choice, multiple-choice (MCQ) and true/false questions.',
    columns: [
      { name: 'course_slug', required: true, help: 'Slug of an existing course' },
      { name: 'quiz_title', required: true, help: 'Quiz / practice test name (created if missing)' },
      { name: 'quiz_type', help: 'practice | mock | diagnostic | final (default practice)' },
      { name: 'quiz_duration_minutes', help: 'Time limit (default 60)' },
      { name: 'pass_percentage', help: '1–100 (default 70)' },
      { name: 'question', required: true, help: 'Question text' },
      {
        name: 'question_type',
        required: true,
        help: 'single = one correct · multiple = MCQ, one or more correct · true_false',
      },
      { name: 'option_a', help: 'Answer A (not needed for true_false)' },
      { name: 'option_b', help: 'Answer B' },
      { name: 'option_c', help: 'Answer C (optional)' },
      { name: 'option_d', help: 'Answer D (optional)' },
      { name: 'option_e', help: 'Answer E (optional)' },
      { name: 'option_f', help: 'Answer F (optional)' },
      {
        name: 'correct_answers',
        required: true,
        help: 'Letter(s) of the correct option(s): A · or A,C for multiple · TRUE/FALSE for true_false',
      },
      { name: 'explanation', help: 'Shown after submitting' },
      { name: 'difficulty', help: 'easy | medium | hard (default medium)' },
      { name: 'topic_tag', help: 'Topic / exam domain, used in result analytics' },
    ],
    sample: [
      {
        course_slug: 'intro-cloud-computing',
        quiz_title: 'Cloud Basics Quiz',
        quiz_type: 'practice',
        quiz_duration_minutes: '15',
        pass_percentage: '70',
        question: 'Which cloud service model gives you the most control over the operating system?',
        question_type: 'single',
        option_a: 'SaaS',
        option_b: 'PaaS',
        option_c: 'IaaS',
        option_d: 'FaaS',
        option_e: '',
        option_f: '',
        correct_answers: 'C',
        explanation: 'With IaaS you manage the OS, runtime and applications; the provider manages hardware.',
        difficulty: 'easy',
        topic_tag: 'Service models',
      },
      {
        course_slug: 'intro-cloud-computing',
        quiz_title: 'Cloud Basics Quiz',
        quiz_type: 'practice',
        quiz_duration_minutes: '15',
        pass_percentage: '70',
        question: 'Which TWO are benefits of cloud computing? (Select two)',
        question_type: 'multiple',
        option_a: 'Trade fixed expense for variable expense',
        option_b: 'Guaranteed zero downtime',
        option_c: 'Go global in minutes',
        option_d: 'No security responsibilities for the customer',
        option_e: '',
        option_f: '',
        correct_answers: 'A,C',
        explanation: 'Pay-as-you-go pricing and global reach are core benefits; security is shared.',
        difficulty: 'medium',
        topic_tag: 'Cloud concepts',
      },
      {
        course_slug: 'intro-cloud-computing',
        quiz_title: 'Cloud Basics Quiz',
        quiz_type: 'practice',
        quiz_duration_minutes: '15',
        pass_percentage: '70',
        question: 'In a public cloud, the customer owns the physical data-centre hardware.',
        question_type: 'true_false',
        option_a: '',
        option_b: '',
        option_c: '',
        option_d: '',
        option_e: '',
        option_f: '',
        correct_answers: 'FALSE',
        explanation: 'The cloud provider owns and operates the hardware.',
        difficulty: 'easy',
        topic_tag: 'Deployment models',
      },
    ],
  },
}

export const IMPORT_TYPES = Object.keys(TEMPLATES)

// ── CSV writing ───────────────────────────────────────────────────────────
const escapeCell = (value) => {
  const s = value == null ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const toCsv = (columns, rows) => {
  const lines = [columns.map(escapeCell).join(',')]
  for (const row of rows) lines.push(columns.map((c) => escapeCell(row[c])).join(','))
  // BOM so Excel opens UTF-8 (₹, é, —) correctly
  return `﻿${lines.join('\r\n')}\r\n`
}

export const templateCsv = (type) => {
  const t = TEMPLATES[type]
  return toCsv(
    t.columns.map((c) => c.name),
    t.sample
  )
}
