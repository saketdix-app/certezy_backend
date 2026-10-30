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

const verifyUrlFor = (certificate_no) => `${env.frontendUrl}/verify/${certificate_no}`

// ── Generate Certificate PDF + Upload ─────────────────────────────────────
const generateCertPDF = async ({
  certificate_no,
  studentName,
  courseId,
  courseTitle,
  issuedAt,
  totalLessons,
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
  })
  await queries.updatePdfUrl(cert.id, url)
  return { ...cert, pdf_url: url }
}

// ── Core: issue certificate ────────────────────────────────────────────────
const issueCertificate = async (user_id, course_id) => {
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

  // DB mein save karo
  const [result] = await queries.createCertificate({
    user_id,
    course_id,
    certificate_no,
    valid_until: null,
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
const getCompletionStatus = async (user_id, course_id) => {
  const enrollment = await checkEnrollment(user_id, course_id)
  if (!enrollment) return { enrolled: false, complete: false, reason: 'You are not enrolled in this course' }
  if ((enrollment.progress ?? 0) < 100) {
    return { enrolled: true, complete: false, reason: 'Complete all lessons to earn your certificate' }
  }
  const [finals] = await queries.getFinalTestResults(user_id, course_id)
  if (finals.some((t) => !Number(t.passed))) {
    return { enrolled: true, complete: false, reason: 'Pass the final test to earn your certificate' }
  }
  return { enrolled: true, complete: true }
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
  return rows
}

// ── Admin — issue certificate manually ────────────────────────────────────
const adminIssueCertificate = async (admin_id, { user_id, course_id }) => {
  const student = await findById(user_id)
  if (!student) {
    const err = new Error('Student not found')
    err.statusCode = 404
    throw err
  }

  return await issueCertificate(user_id, course_id)
}

// ── Admin — all certificates ───────────────────────────────────────────────
const getAllCertificates = async ({ page = 1, limit = 20 } = {}) => {
  const offset = (page - 1) * limit

  const [rows] = await queries.getAllCertificates({ limit, offset })
  const [count] = await queries.countCertificates()

  return {
    certificates: rows,
    pagination: {
      total: count[0].total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(count[0].total / limit),
    },
  }
}

export {
  issueCertificate,
  autoIssueOnCompletion,
  claimCertificate,
  verifyCertificate,
  getMyCertificates,
  adminIssueCertificate,
  getAllCertificates,
}
