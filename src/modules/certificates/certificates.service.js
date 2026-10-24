// src/modules/certificates/certificates.service.js

import * as queries from './certificates.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import { findById } from '../auth/auth.queries.js'
import { generateCertNumber } from '../../utils/generate.js'
import { uploadFile } from '../../utils/upload.js'
import PDFDocument from 'pdfkit'

// ── Generate Certificate PDF + Upload ─────────────────────────────────────
const generateCertPDF = ({ certificate_no, studentName, courseTitle, issuedAt }) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4', layout: 'landscape' })
      const chunks = []

      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('error', reject)
      doc.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks)
          const key = `certificates/${certificate_no}.pdf`
          const url = await uploadFile({ buffer, key, mimeType: 'application/pdf', isPublic: true })
          resolve({ url, key })
        } catch (err) {
          reject(err)
        }
      })

      // Background border
      doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).stroke('#C9A84C')

      // Title
      doc
        .moveDown(2)
        .fontSize(36)
        .font('Helvetica-Bold')
        .fillColor('#1a1a2e')
        .text('CERTIFICATE OF COMPLETION', { align: 'center' })
        .moveDown(1)

      // Subtitle
      doc
        .fontSize(14)
        .font('Helvetica')
        .fillColor('#555')
        .text('This is to certify that', { align: 'center' })
        .moveDown(0.5)

      // Student name
      doc
        .fontSize(28)
        .font('Helvetica-Bold')
        .fillColor('#C9A84C')
        .text(studentName, { align: 'center' })
        .moveDown(0.5)

      // Course
      doc
        .fontSize(14)
        .font('Helvetica')
        .fillColor('#555')
        .text('has successfully completed the course', { align: 'center' })
        .moveDown(0.5)

      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .fillColor('#1a1a2e')
        .text(courseTitle, { align: 'center' })
        .moveDown(1.5)

      // Certificate number + date
      doc
        .fontSize(11)
        .font('Helvetica')
        .fillColor('#888')
        .text(`Certificate No: ${certificate_no}`, { align: 'center' })
        .text(`Issued on: ${new Date(issuedAt).toLocaleDateString('en-IN')}`, { align: 'center' })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
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

  const cert_id = result.insertId

  // PDF generate + upload karo
  const { url: pdf_url } = await generateCertPDF({
    certificate_no,
    studentName: student.name,
    courseTitle: course.title,
    issuedAt: new Date(),
  })

  // pdf_url DB mein update karo
  await queries.updatePdfUrl(cert_id, pdf_url)

  const [rows] = await queries.getCertificateById(cert_id)
  return rows[0]
}

// ── Auto trigger — called from progress + attempts service ─────────────────
const tryAutoIssueCertificate = async (user_id, course_id, { progress, is_passed }) => {
  if (progress >= 100 && is_passed) {
    return await issueCertificate(user_id, course_id)
  }
  return null
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
  tryAutoIssueCertificate,
  getMyCertificates,
  adminIssueCertificate,
  getAllCertificates,
}
