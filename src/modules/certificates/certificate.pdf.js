// src/modules/certificates/certificate.pdf.js
// Draws the Certezy E-Learning Pvt. Ltd. certificate of completion (A4 landscape).
// Pure rendering — returns a PDF Buffer; the service uploads it.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'

export const ISSUER = 'Certezy E-Learning Pvt. Ltd.'

const LOGO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/certezy-logo.png')

const NAVY = '#0F2545'
const BLUE = '#3282B8'
const GOLD = '#B8913A'
const GOLD_LIGHT = '#E3CC8F'
const INK = '#1F2937'
const MUTED = '#6B7280'
const PAPER = '#FDFCF8'

// First + last name as printed: "rahul KUMAR sharma" → "Rahul Kumar Sharma".
// Words typed in mixed case (McDonald, DeSouza) are kept as the student wrote them.
export const formatCertificateName = (name = '') =>
  String(name)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) =>
      word === word.toLowerCase() || word === word.toUpperCase()
        ? word.toLowerCase().replace(/(^|['-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
        : word
    )
    .join(' ')

const formatDate = (d) =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

// Text centred in a box, shrinking the font until it fits on one line
const fitText = (doc, text, { x, y, width, font, size, min = 12, color, characterSpacing = 0 }) => {
  doc.font(font)
  let s = size
  while (s > min && doc.fontSize(s).widthOfString(text, { characterSpacing }) > width) s -= 1
  doc
    .fillColor(color)
    .fontSize(s)
    .text(text, x, y, { width, align: 'center', lineBreak: false, characterSpacing })
  return s
}

const cornerOrnament = (doc, cx, cy, sx, sy) => {
  doc.save().lineWidth(1.4).strokeColor(GOLD)
  doc
    .moveTo(cx, cy + sy * 46)
    .lineTo(cx, cy)
    .lineTo(cx + sx * 46, cy)
    .stroke()
  doc
    .moveTo(cx + sx * 8, cy + sy * 30)
    .lineTo(cx + sx * 8, cy + sy * 8)
    .lineTo(cx + sx * 30, cy + sy * 8)
    .stroke()
  doc.circle(cx + sx * 8, cy + sy * 8, 2.4).fill(GOLD)
  doc.restore()
}

const seal = (doc, cx, cy) => {
  doc.save()
  // scalloped rosette
  const points = 24
  doc.moveTo(cx + 50, cy)
  for (let i = 1; i <= points * 2; i++) {
    const a = (Math.PI * i) / points
    const r = i % 2 ? 44 : 50
    doc.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  doc.fill(GOLD)
  doc.circle(cx, cy, 39).fill(GOLD_LIGHT)
  doc.circle(cx, cy, 35).lineWidth(1).stroke(GOLD)
  doc.circle(cx, cy, 31).fill(NAVY)
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5)
  doc.text('CERTEZY', cx - 30, cy - 15, { width: 60, align: 'center', characterSpacing: 1.2 })
  doc.font('Helvetica').fontSize(6.2).fillColor(GOLD_LIGHT)
  doc.text('DIGITALLY', cx - 30, cy - 2, { width: 60, align: 'center', characterSpacing: 0.8 })
  doc.text('VERIFIED', cx - 30, cy + 6, { width: 60, align: 'center', characterSpacing: 0.8 })
  doc.restore()
}

/**
 * @param {{ certificateNo: string, studentName: string, courseTitle: string,
 *           issuedAt: Date|string, verifyUrl?: string, durationLabel?: string }} data
 * @returns {Promise<Buffer>}
 */
export const renderCertificatePdf = ({
  certificateNo,
  studentName,
  courseTitle,
  issuedAt,
  verifyUrl,
  durationLabel,
}) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 0,
      info: {
        Title: `Certificate of Completion — ${courseTitle}`,
        Author: ISSUER,
        Subject: `${formatCertificateName(studentName)} · ${certificateNo}`,
      },
    })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const W = doc.page.width // 841.89
    const H = doc.page.height // 595.28
    const cx = W / 2

    // ── Paper + frames ────────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill(PAPER)
    doc.rect(0, 0, W, H).lineWidth(28).stroke(NAVY) // outer navy band (14pt visible)
    doc.rect(14, 14, W - 28, 5).fill(BLUE)
    doc.rect(14, H - 19, W - 28, 5).fill(BLUE)
    doc
      .rect(30, 30, W - 60, H - 60)
      .lineWidth(1.6)
      .stroke(GOLD)
    doc
      .rect(36, 36, W - 72, H - 72)
      .lineWidth(0.6)
      .stroke(GOLD_LIGHT)
    cornerOrnament(doc, 46, 46, 1, 1)
    cornerOrnament(doc, W - 46, 46, -1, 1)
    cornerOrnament(doc, 46, H - 46, 1, -1)
    cornerOrnament(doc, W - 46, H - 46, -1, -1)

    // faint watermark
    doc.save().opacity(0.035).fillColor(NAVY).font('Helvetica-Bold').fontSize(150)
    doc.text('CERTEZY', 0, H / 2 - 80, { width: W, align: 'center', lineBreak: false })
    doc.restore()

    // ── Header ────────────────────────────────────────────────────────
    const logoW = 170
    doc.image(LOGO, cx - logoW / 2, 62, { width: logoW })

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(34)
    doc.text('CERTIFICATE', 0, 128, { width: W, align: 'center', characterSpacing: 6 })
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12.5)
    doc.text('OF  COMPLETION', 0, 170, { width: W, align: 'center', characterSpacing: 4 })
    doc
      .moveTo(cx - 120, 194)
      .lineTo(cx - 14, 194)
      .lineWidth(0.8)
      .stroke(GOLD)
    doc
      .moveTo(cx + 14, 194)
      .lineTo(cx + 120, 194)
      .stroke(GOLD)
    doc.save().translate(cx, 194).rotate(45).rect(-3.5, -3.5, 7, 7).fill(GOLD).restore()

    // ── Body ──────────────────────────────────────────────────────────
    doc.fillColor(MUTED).font('Times-Italic').fontSize(15)
    doc.text('This is to certify that', 0, 214, { width: W, align: 'center' })

    fitText(doc, formatCertificateName(studentName), {
      x: 90,
      y: 240,
      width: W - 180,
      font: 'Times-BoldItalic',
      size: 44,
      min: 22,
      color: NAVY,
    })
    doc
      .moveTo(cx - 230, 296)
      .lineTo(cx + 230, 296)
      .lineWidth(0.8)
      .stroke(GOLD)

    doc.fillColor(MUTED).font('Times-Italic').fontSize(15)
    doc.text('has successfully completed the online course', 0, 310, { width: W, align: 'center' })

    doc.font('Helvetica-Bold').fillColor(INK)
    const titleSize = doc.fontSize(21).widthOfString(courseTitle) > W - 220 ? 17 : 21
    doc.fontSize(titleSize)
    const titleH = Math.min(50, doc.heightOfString(courseTitle, { width: W - 220 }))
    doc.text(courseTitle, 110, 336, { width: W - 220, align: 'center', height: 50, ellipsis: true })

    const sub = [durationLabel, `offered by ${ISSUER}`].filter(Boolean).join('  ·  ')
    doc.fillColor(MUTED).font('Helvetica').fontSize(10.5)
    doc.text(sub, 0, 336 + titleH + 10, { width: W, align: 'center' })

    // ── Footer: date · seal · signatory ──────────────────────────────
    const footY = 452
    const colW = 200
    const leftX = 110
    const rightX = W - 110 - colW

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
    doc.text(formatDate(issuedAt), leftX, footY, { width: colW, align: 'center' })
    doc
      .moveTo(leftX + 20, footY + 22)
      .lineTo(leftX + colW - 20, footY + 22)
      .lineWidth(0.7)
      .stroke(MUTED)
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
    doc.text('DATE OF ISSUE', leftX, footY + 30, { width: colW, align: 'center', characterSpacing: 1.2 })

    seal(doc, cx, footY + 18)

    doc.fillColor(NAVY).font('Times-BoldItalic').fontSize(16)
    doc.text(ISSUER, rightX, footY + 1, { width: colW, align: 'center' })
    doc
      .moveTo(rightX + 20, footY + 22)
      .lineTo(rightX + colW - 20, footY + 22)
      .lineWidth(0.7)
      .stroke(MUTED)
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
    doc.text('AUTHORISED SIGNATORY', rightX, footY + 30, {
      width: colW,
      align: 'center',
      characterSpacing: 1.2,
    })

    // ── Verification strip ───────────────────────────────────────────
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
    const strip = verifyUrl
      ? `Certificate No. ${certificateNo}   ·   Verify at ${verifyUrl.replace(/^https?:\/\//, '')}`
      : `Certificate No. ${certificateNo}`
    doc.text(strip, 0, H - 64, { width: W, align: 'center', characterSpacing: 0.3 })

    doc.end()
  })
