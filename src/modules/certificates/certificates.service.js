// src/modules/certificates/certificates.service.js

import * as queries from './certificates.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import { findById } from '../auth/auth.queries.js'
import { generateCertNumber } from '../../utils/generate.js'
import { uploadFile } from '../../utils/upload.js'
import env from '../../config/env.js'
import { getCourseMeta } from '../lessons/lessons.queries.js'
import { checkEnrollment } from '../enrollments/enrollments.service.js'
import { renderCertificatePdf, formatCertificateName, ISSUER } from './certificate.pdf.js'
import { contactHoursFor, pduIdFor } from './contactHours.js'

// 'YYYY-MM-DD' (UTC) for a date column
const toDay = (d) => new Date(d).toISOString().slice(0, 10)

const verifyUrlFor = (certificate_no) => `${env.frontendUrl}/verify/${certificate_no}`

// ── Generate Certificate PDF + Upload ─────────────────────────────────────
const generateCertPDF = async ({
  certificate_no,
  studentName,
  courseId,
  courseTitle,
  issuedAt,
  totalLessons,
  trainingStart,
  trainingEnd,
}) => {
  const contactHours = contactHoursFor(courseId)
  const buffer = await renderCertificatePdf({
    certificateNo: certificate_no,
    studentName,
    courseTitle,
    issuedAt,
    verifyUrl: verifyUrlFor(certificate_no),
    durationLabel: totalLessons ? `${totalLessons} lessons` : undefined,
    contactHours,
    pduId: contactHours ? pduIdFor(certificate_no) : undefined,
    // Training period only on contact-hour (PMP) certificates; the others
    // show their completion date
    trainingStart: contactHours ? trainingStart : undefined,
    trainingEnd: contactHours ? trainingEnd : undefined,
    dateLabel: contactHours ? 'DATE OF ISSUE' : 'DATE OF COMPLETION',
  })
  const key = `certificates/${certificate_no}.pdf`
  const url = await uploadFile({ buffer, key, mimeType: 'application/pdf', isPublic: true })
  return { url, key }
}

// (Re)build the PDF for a stored certificate row — used on issue and to
// repair certificates whose upload failed earlier.
const attachPdf = async (cert, { student, course }) => {
  const [metaRows] = await getCourseMeta(course.id)
  const { url } = await generateCertPDF({
    certificate_no: cert.certificate_no,
    studentName: student.name,
    courseId: course.id,
    courseTitle: course.title,
    issuedAt: cert.issued_at || new Date(),
    totalLessons: metaRows[0]?.total_lessons,
    trainingStart: cert.training_start,
    trainingEnd: cert.training_end,
  })
  await queries.updatePdfUrl(cert.id, url)
  return { ...cert, pdf_url: url }
}

// ── Reissue: same certificate number, today's date, fresh PDF ─────────────
const reissueCertificate = async (cert) => {
  await queries.touchIssuedAt(cert.id)
  // Older PMP certificates had no training period: enrollment day → today
  if (!cert.training_start && contactHoursFor(cert.course_id)) {
    const enrollment = await checkEnrollment(cert.user_id, cert.course_id)
    if (enrollment?.enrolled_at) {
      const [now] = await queries.getCertificateById(cert.id)
      await queries.updateCertificateDates(cert.id, {
        issued_at: now[0].issued_at,
        training_start: toDay(enrollment.enrolled_at),
        training_end: toDay(new Date()),
      })
    }
  }
  const [rows] = await queries.getCertificateById(cert.id)
  const [courseRows] = await courseQueries.getCourseById(cert.course_id)
  const student = await findById(cert.user_id)
  const updated = await attachPdf(rows[0], { student, course: courseRows[0] })
  // Same S3 key is overwritten — a version query makes browsers fetch the new file
  const pdf_url = `${updated.pdf_url.split('?')[0]}?v=${Date.now()}`
  await queries.updatePdfUrl(cert.id, pdf_url)
  return { ...updated, pdf_url }
}

// ── Called whenever a student passes a test of the course ─────────────────
// Already certified → reissue with the new date; otherwise issue it if the
// course is now complete. Never throws (a certificate problem must not fail
// the exam submission). `issuedBefore` lets the caller decide before anything
// else in the request could have issued it.
const issueOrReissueOnPass = async (user_id, course_id, { issuedBefore } = {}) => {
  try {
    const [existing] = await queries.getCertificateByUserAndCourse(user_id, course_id)
    if (existing.length && issuedBefore !== false) {
      return { certificate: await reissueCertificate(existing[0]), reissued: true }
    }
    if (existing.length) return { certificate: existing[0], reissued: false }
    return { certificate: await autoIssueOnCompletion(user_id, course_id), reissued: false }
  } catch (err) {
    console.error(`Certificate on pass failed (user ${user_id}, course ${course_id}):`, err.message)
    return { certificate: null, reissued: false }
  }
}

const hasCertificate = async (user_id, course_id) => {
  const [rows] = await queries.getCertificateByUserAndCourse(user_id, course_id)
  return rows.length > 0
}

// ── Core: issue certificate ────────────────────────────────────────────────
const issueCertificate = async (user_id, course_id, { issued_at, training_start, training_end } = {}) => {
  // Already issued check
  const [existing] = await queries.getCertificateByUserAndCourse(user_id, course_id)
  if (existing.length) return existing[0]

  // Course exists + certificate_eligible check
  const [courseRows] = await courseQueries.getCourseById(course_id)
  if (!courseRows.length) {
    const err = new Error('Course not found')
    err.statusCode = 404
    throw err
  }
  const course = courseRows[0]

  if (!course.certificate_eligible) {
    const err = new Error('This course does not offer a certificate')
    err.statusCode = 400
    throw err
  }

  // Student info fetch karo
  const student = await findById(user_id)
  if (!student) {
    const err = new Error('Student not found')
    err.statusCode = 404
    throw err
  }

  // Certificate number generate karo
  const certificate_no = generateCertNumber()

  // Training period (PMP only): given by an admin, otherwise enrollment day →
  // completion day
  const withTraining = Boolean(contactHoursFor(course_id))
  const enrollment = training_start || !withTraining ? null : await checkEnrollment(user_id, course_id)
  const start = training_start ?? (enrollment?.enrolled_at ? toDay(enrollment.enrolled_at) : null)
  const end = training_end ?? toDay(issued_at ?? new Date())

  // DB mein save karo
  const [result] = await queries.createCertificate({
    user_id,
    course_id,
    certificate_no,
    valid_until: null,
    issued_at,
    training_start: withTraining ? start : null,
    training_end: withTraining && start ? end : null,
  })

  const [rows] = await queries.getCertificateById(result.insertId)

  // PDF generate + upload karo. If storage fails the certificate still exists;
  // the PDF is rebuilt the next time the student opens/claims it.
  try {
    return await attachPdf(rows[0], { student, course })
  } catch (err) {
    console.error(`Certificate ${certificate_no}: PDF generation failed —`, err.message)
    return rows[0]
  }
}

// ── Has the student finished the course? ──────────────────────────────────
// All lessons completed (progress 100%) and every active final test passed.
const requiredExams = async (user_id, course_id) => {
  const [rows] = await queries.getRequiredTestResults(user_id, course_id)
  return rows.map((t) => ({ id: t.id, title: t.title, passed: Boolean(Number(t.passed)) }))
}

// All lessons completed and every course exam passed
const getCompletionStatus = async (user_id, course_id) => {
  const enrollment = await checkEnrollment(user_id, course_id)
  if (!enrollment) return { enrolled: false, complete: false, reason: 'You are not enrolled in this course' }
  if ((enrollment.progress ?? 0) < 100) {
    return {
      enrolled: true,
      complete: false,
      exams: await requiredExams(user_id, course_id),
      reason: 'Complete all lessons to earn your certificate',
    }
  }
  const exams = await requiredExams(user_id, course_id)
  const left = exams.filter((t) => !t.passed)
  if (left.length) {
    return {
      enrolled: true,
      complete: false,
      exams,
      reason:
        left.length === 1
          ? `Pass "${left[0].title}" to earn your certificate`
          : `Pass all ${exams.length} course exams to earn your certificate (${exams.length - left.length} of ${exams.length} passed)`,
    }
  }
  return { enrolled: true, complete: true, exams }
}

// ── Auto issue — called when a lesson is completed or a final test passed ─
// Never throws: a certificate problem must not fail the student's progress save.
const autoIssueOnCompletion = async (user_id, course_id) => {
  try {
    const [courseRows] = await courseQueries.getCourseById(course_id)
    if (!courseRows.length || !courseRows[0].certificate_eligible) return null
    const { complete } = await getCompletionStatus(user_id, course_id)
    if (!complete) return null
    return await issueCertificate(user_id, course_id)
  } catch (err) {
    console.error(`Auto certificate failed (user ${user_id}, course ${course_id}):`, err.message)
    return null
  }
}

// ── Student — get (or issue) my certificate for a finished course ─────────
// Covers courses finished before auto-issue existed, and re-creates a PDF
// whose upload failed.
const claimCertificate = async (user_id, course_id) => {
  const [existing] = await queries.getCertificateByUserAndCourse(user_id, course_id)
  if (existing.length) {
    const cert = existing[0]
    if (cert.pdf_url) return cert
    const [courseRows] = await courseQueries.getCourseById(course_id)
    const student = await findById(user_id)
    return await attachPdf(cert, { student, course: courseRows[0] })
  }

  const status = await getCompletionStatus(user_id, course_id)
  if (!status.complete) {
    const err = new Error(status.reason)
    err.statusCode = status.enrolled ? 400 : 403
    throw err
  }
  return await issueCertificate(user_id, course_id)
}

// ── Public — verify a certificate number ──────────────────────────────────
const verifyCertificate = async (certificate_no) => {
  const [rows] = await queries.getCertificateForVerify(String(certificate_no).trim().toUpperCase())
  if (!rows.length) {
    const err = new Error('Certificate not found')
    err.statusCode = 404
    throw err
  }
  const c = rows[0]
  return {
    certificate_no: c.certificate_no,
    student_name: formatCertificateName(c.student_name),
    course_title: c.course_title,
    course_slug: c.course_slug,
    issued_at: c.issued_at,
    // Training period is only part of contact-hour (PMP) certificates
    training_start: contactHoursFor(c.course_id) ? c.training_start : null,
    training_end: contactHoursFor(c.course_id) ? c.training_end : null,
    valid_until: c.valid_until,
    pdf_url: c.pdf_url,
    issuer: ISSUER,
    ...(contactHoursFor(c.course_id) && {
      contact_hours: contactHoursFor(c.course_id).hours,
      pdu_id: pduIdFor(c.certificate_no),
    }),
  }
}

// ── My certificates (student) ──────────────────────────────────────────────
const getMyCertificates = async (user_id) => {
  const [rows] = await queries.getCertificatesByUserId(user_id)
  return rows.map((r) =>
    contactHoursFor(r.course_id) ? r : { ...r, training_start: null, training_end: null }
  )
}

// ── Admin — issue certificate manually ────────────────────────────────────
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode })

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

// Training dates apply to contact-hour (PMP) certificates only; others ignore them
const trainingFor = (course_id, { training_start, training_end }) =>
  contactHoursFor(course_id) ? { training_start, training_end } : { training_start: null, training_end: null }

/**
 * Checks the admin's dates (all 'YYYY-MM-DD'): training start ≤ end, nothing
 * in the future, issue date not before the training ended.
 */
const parseAdminDates = ({ issue_date, training_start, training_end }) => {
  const day = (v, label) => {
    if (v == null || v === '') return null
    if (!DAY_RE.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) {
      throw httpError(400, `${label} must be a valid date`)
    }
    return v
  }
  const issue = day(issue_date, 'Issue date')
  const start = day(training_start, 'Training start date')
  const end = day(training_end, 'Training end date')
  const today = toDay(new Date(Date.now() + 14 * 3600e3)) // allow for time zones ahead of UTC

  if (Boolean(start) !== Boolean(end)) throw httpError(400, 'Enter both the training start and end dates')
  if (start && start > end) throw httpError(400, 'Training start date must be on or before the end date')
  for (const [v, label] of [
    [issue, 'Issue date'],
    [end, 'Training end date'],
  ]) {
    if (v && v > today) throw httpError(400, `${label} cannot be in the future`)
  }
  if (issue && end && issue < end) throw httpError(400, 'Issue date cannot be before the training end date')

  return {
    issued_at: issue ? new Date(`${issue}T12:00:00Z`) : undefined,
    training_start: start,
    training_end: end,
  }
}

// Admin: issue to any student, e.g. classroom batches or corrections.
// Dates (YYYY-MM-DD, optional) are printed on the PDF. replace: true
// overwrites the student's existing certificate for the course instead of
// refusing — same certificate number, new dates and PDF.
const adminIssueCertificate = async (
  admin_id,
  { user_id, course_id, issue_date, training_start, training_end, replace }
) => {
  if (!Number(user_id) || !Number(course_id)) throw httpError(400, 'Choose a student and a course')
  const student = await findById(user_id)
  if (!student) throw httpError(404, 'Student not found')
  if (student.role !== 'student') throw httpError(400, 'Certificates can only be issued to student accounts')
  const dates = parseAdminDates({ issue_date, ...trainingFor(course_id, { training_start, training_end }) })

  const [existing] = await queries.getCertificateByUserAndCourse(user_id, course_id)
  if (existing.length) {
    if (replace) return regenerateCertificate(existing[0].id, { issue_date, training_start, training_end })
    throw httpError(
      409,
      `${student.name} already has a certificate for this course (${existing[0].certificate_no}). Choose "Replace existing certificate" to overwrite it.`
    )
  }
  return await issueCertificate(user_id, course_id, dates)
}

// ── Admin — regenerate (overwrite) a certificate with corrected dates ─────
// Keeps the certificate number, so links already shared keep verifying.
const regenerateCertificate = async (id, { issue_date, training_start, training_end } = {}) => {
  const [rows] = await queries.getCertificateById(id)
  const cert = rows[0]
  if (!cert) throw httpError(404, 'Certificate not found')
  const dates = parseAdminDates({
    issue_date,
    ...trainingFor(cert.course_id, { training_start, training_end }),
  })

  await queries.updateCertificateDates(cert.id, dates)
  const [fresh] = await queries.getCertificateById(cert.id)
  const [courseRows] = await courseQueries.getCourseById(cert.course_id)
  const student = await findById(cert.user_id)
  if (!courseRows.length || !student) throw httpError(404, 'Course or student not found')

  const updated = await attachPdf(fresh[0], { student, course: courseRows[0] })
  // Same S3 key is overwritten — a version query makes browsers fetch the new file
  const pdf_url = `${updated.pdf_url.split('?')[0]}?v=${Date.now()}`
  await queries.updatePdfUrl(cert.id, pdf_url)
  return { ...updated, pdf_url, regenerated: true }
}

// ── Admin — all certificates ───────────────────────────────────────────────
const getAllCertificates = async ({ page = 1, limit = 20, search } = {}) => {
  page = Math.max(1, Number(page) || 1)
  limit = Math.min(100, Math.max(1, Number(limit) || 20))
  const offset = (page - 1) * limit
  const q = search ? String(search).slice(0, 100) : ''

  const [rows] = await queries.getAllCertificates({ limit, offset, search: q })
  const [count] = await queries.countCertificates(q)
  const total = Number(count[0].total)

  return {
    certificates: rows.map((r) => ({
      ...r,
      verify_url: `${env.frontendUrl}/verify/${r.certificate_no}`,
      has_training_period: Boolean(contactHoursFor(r.course_id)),
    })),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  }
}

// ── Admin — revoke a certificate ──────────────────────────────────────────
const revokeCertificate = async (id) => {
  const [rows] = await queries.getCertificateById(id)
  if (!rows.length) throw httpError(404, 'Certificate not found')
  await queries.deleteCertificate(id)
  return { id: Number(id), certificate_no: rows[0].certificate_no }
}

// ── Student — can I get the certificate yet? (for the course player) ──────
const getCertificateStatus = async (user_id, course_id) => {
  const status = await getCompletionStatus(user_id, course_id)
  const [existing] = await queries.getCertificateByUserAndCourse(user_id, course_id)
  return {
    ...status,
    has_certificate: existing.length > 0,
    certificate_no: existing[0]?.certificate_no ?? null,
  }
}

export {
  getCertificateStatus,
  issueCertificate,
  autoIssueOnCompletion,
  issueOrReissueOnPass,
  hasCertificate,
  claimCertificate,
  verifyCertificate,
  getMyCertificates,
  adminIssueCertificate,
  getAllCertificates,
  revokeCertificate,
  regenerateCertificate,
}
