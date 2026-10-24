// src/utils/generate.js

import { randomBytes } from 'crypto'
import { v4 as uuidv4 } from 'uuid'

// ── Generate UUID (discount token etc) ────────────────────────────────────
const generateUUID = () => uuidv4()

// ── Generate Invoice Number ────────────────────────────────────────────────
// Format: INV-2024-XXXXXX (year + 6 random digits)
const generateInvoiceNumber = () => {
  const year = new Date().getFullYear()
  const random = Math.floor(100000 + Math.random() * 900000) // 6 digit
  return `INV-${year}-${random}`
}

// ── Generate Random Password (sub-admin ke liye) ───────────────────────────
// Format: 10 character alphanumeric
const generateRandomPassword = () => {
  return randomBytes(6)
    .toString('base64')
    .slice(0, 10)
    .replace(/[^a-zA-Z0-9]/g, 'X')
}

// ── Generate Certificate Number ────────────────────────────────────────────
// Format: CERT-2024-XXXXXXXXXX (year + 10 random hex chars)
const generateCertNumber = () => {
  const year = new Date().getFullYear()
  const random = randomBytes(5).toString('hex').toUpperCase() // 10 chars
  return `CERT-${year}-${random}`
}

export { generateUUID, generateInvoiceNumber, generateRandomPassword, generateCertNumber }
