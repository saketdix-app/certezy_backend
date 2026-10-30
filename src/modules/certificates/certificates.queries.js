// src/modules/certificates/certificates.queries.js

import { pool } from '../../config/db.js'

// ── Create certificate ─────────────────────────────────────────────────────
const createCertificate = ({ user_id, course_id, certificate_no, valid_until }) =>
  pool.query(
    `INSERT INTO certificates (user_id, course_id, certificate_no, valid_until)
     VALUES (?, ?, ?, ?)`,
    [user_id, course_id, certificate_no, valid_until ?? null]
  )

// ── Get certificate by ID ──────────────────────────────────────────────────
const getCertificateById = (id) => pool.query(`SELECT * FROM certificates WHERE id = ? LIMIT 1`, [id])

// ── Get certificate by user + course ──────────────────────────────────────
const getCertificateByUserAndCourse = (user_id, course_id) =>
  pool.query(
    `SELECT * FROM certificates
     WHERE user_id = ? AND course_id = ? LIMIT 1`,
    [user_id, course_id]
  )

// ── Update pdf_url after generation ───────────────────────────────────────
const updatePdfUrl = (id, pdf_url) =>
  pool.query(`UPDATE certificates SET pdf_url = ? WHERE id = ?`, [pdf_url, id])

// ── Public verification by certificate number ─────────────────────────────
const getCertificateForVerify = (certificate_no) =>
  pool.query(
    `SELECT
       cert.certificate_no, cert.course_id, cert.issued_at, cert.valid_until, cert.pdf_url,
       u.name AS student_name,
       c.title AS course_title, c.slug AS course_slug
     FROM certificates cert
     JOIN users u   ON u.id = cert.user_id
     JOIN courses c ON c.id = cert.course_id
     WHERE cert.certificate_no = ? LIMIT 1`,
    [certificate_no]
  )

// ── Final tests of a course + whether the student has passed each ─────────
const getFinalTestResults = (user_id, course_id) =>
  pool.query(
    `SELECT t.id,
       EXISTS(
         SELECT 1 FROM test_attempts a
         WHERE a.test_id = t.id AND a.user_id = ? AND a.is_passed = 1
       ) AS passed
     FROM tests t
     WHERE t.course_id = ? AND t.type = 'final' AND t.status = 'active'`,
    [user_id, course_id]
  )

// ── Get all certificates of a student ─────────────────────────────────────
const getCertificatesByUserId = (user_id) =>
  pool.query(
    `SELECT
       cert.id, cert.course_id, cert.certificate_no, cert.issued_at,
       cert.valid_until, cert.pdf_url,
       c.title AS course_title, c.slug AS course_slug,
       c.thumbnail AS course_thumbnail
     FROM certificates cert
     JOIN courses c ON c.id = cert.course_id
     WHERE cert.user_id = ?
     ORDER BY cert.issued_at DESC`,
    [user_id]
  )

// ── Admin — get all certificates ───────────────────────────────────────────
const getAllCertificates = ({ limit, offset }) =>
  pool.query(
    `SELECT
       cert.id, cert.certificate_no, cert.issued_at,
       cert.valid_until, cert.pdf_url,
       u.name AS student_name, u.email AS student_email,
       c.title AS course_title
     FROM certificates cert
     JOIN users u    ON u.id = cert.user_id
     JOIN courses c  ON c.id = cert.course_id
     ORDER BY cert.issued_at DESC
     LIMIT ? OFFSET ?`,
    [Number(limit), Number(offset)]
  )

// ── Count all certificates ─────────────────────────────────────────────────
const countCertificates = () => pool.query(`SELECT COUNT(*) AS total FROM certificates`)

export {
  createCertificate,
  getCertificateById,
  getCertificateByUserAndCourse,
  updatePdfUrl,
  getCertificatesByUserId,
  getCertificateForVerify,
  getFinalTestResults,
  getAllCertificates,
  countCertificates,
}
