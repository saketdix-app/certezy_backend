// src/modules/certificates/contactHours.js
// Courses whose certificate states training contact hours (PMI requires 35
// contact hours of project management education to apply for the PMP exam).
// Keyed by course id, which stays the same when the title or slug changes.

import { createHash } from 'node:crypto'

const CONTACT_HOUR_COURSES = {
  44: { hours: 35, subject: 'Project Management' }, // PMP — Project Management Professional prep
}

/** @returns {{ hours: number, subject: string } | null} */
export const contactHoursFor = (course_id) => CONTACT_HOUR_COURSES[course_id] ?? null

/**
 * PDU ID printed on contact-hour certificates: "PDU-2026-9F3A61C2". Derived from
 * the (unique) certificate number, so it is unique, never changes when the PDF is
 * rebuilt, and needs no extra database column.
 */
export const pduIdFor = (certificate_no) => {
  const year = /-(\d{4})-/.exec(certificate_no)?.[1] ?? new Date().getFullYear()
  const hash = createHash('sha256').update(`pdu:${certificate_no}`).digest('hex').slice(0, 8).toUpperCase()
  return `PDU-${year}-${hash}`
}
