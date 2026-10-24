// src/utils/invoice.js

import PDFDocument from 'pdfkit'
import { uploadFile } from './upload.js'

// ── Generate Invoice PDF + Upload to Spaces ────────────────────────────────
const generateInvoice = ({
  invoiceNumber,
  studentName,
  studentEmail,
  courseTitle,
  amount,
  currency,
  transactionId,
  date,
}) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 })
      const chunks = []

      // PDF buffer mein collect karo
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('error', reject)
      doc.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks)

          // DigitalOcean Spaces pe upload karo
          // Key format: invoices/INV-2024-XXXX.pdf
          const key = `invoices/${invoiceNumber}.pdf`
          const url = await uploadFile({
            buffer,
            key,
            mimeType: 'application/pdf',
            isPublic: true,
          })

          resolve({ url, key })
        } catch (err) {
          reject(err)
        }
      })

      // ── PDF Content ───────────────────────────────────────────────────

      // Header
      doc.fontSize(24).font('Helvetica-Bold').text('INVOICE', { align: 'right' }).moveDown(0.5)

      doc
        .fontSize(10)
        .font('Helvetica')
        .text(`Invoice No: ${invoiceNumber}`, { align: 'right' })
        .text(`Date: ${new Date(date).toLocaleDateString('en-IN')}`, { align: 'right' })
        .moveDown(2)

      // Company name
      doc.fontSize(16).font('Helvetica-Bold').text('Certezy').moveDown(0.3)

      doc.fontSize(10).font('Helvetica').text('Online Learning Platform').moveDown(2)

      // Divider
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(1)

      // Bill To
      doc.fontSize(12).font('Helvetica-Bold').text('Bill To:').moveDown(0.3)

      doc
        .fontSize(10)
        .font('Helvetica')
        .text(`Name  : ${studentName}`)
        .text(`Email : ${studentEmail}`)
        .moveDown(2)

      // Divider
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(1)

      // Course detail
      doc.fontSize(12).font('Helvetica-Bold').text('Course Details:').moveDown(0.5)

      doc
        .fontSize(10)
        .font('Helvetica')
        .text(`Course     : ${courseTitle}`)
        .text(`Amount     : ${currency} ${Number(amount).toFixed(2)}`)
        .text(`Transaction: ${transactionId}`)
        .moveDown(2)

      // Divider
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(1)

      // Total
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text(`Total: ${currency} ${Number(amount).toFixed(2)}`, { align: 'right' })
        .moveDown(2)

      // Footer
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('grey')
        .text('Thank you for your purchase!', { align: 'center' })
        .text('For support: support@certezy.com', { align: 'center' })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

export { generateInvoice }
