// src/modules/enquiries/enquiries.service.js
// Course-page enquiries → CRM leads (source "website"), with the course set:
//   • advisor  — "Talk to an advisor" (phone required)
//   • syllabus — "Download the syllabus" (email required; the syllabus is shown
//                straight away and emailed)
//   • team     — "Training a team?" quote (company + email or phone)
// Same intake pipeline as Meta / LinkedIn / the contact form: duplicate checks
// (an existing lead gets the enquiry on its timeline, owner notified) and
// Round Robin. These forms are always on — they exist only to create leads.

import crypto from 'node:crypto'
import env from '../../config/env.js'
import { pool } from '../../config/db.js'
import { managerIds, notify } from '../../utils/notify.js'
import { processEvent, recordEvent } from '../integrations/ingest.service.js'
import { sendSyllabusJob } from '../../jobs/emailQueue.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

export const KINDS = {
  advisor: { label: 'Talk to an advisor', note: 'Asked for an advisor call on the course page' },
  syllabus: { label: 'Syllabus download', note: 'Downloaded the syllabus from the course page' },
  team: { label: 'Team training quote', note: 'Asked for a team training quote on the course page' },
}

/** Sections and lesson titles, in order (what the syllabus shows). */
export const courseSyllabus = async (courseId) => {
  const [rows] = await pool.query(
    `SELECT s.id AS section_id, s.title AS section_title, l.title AS lesson_title
     FROM sections s LEFT JOIN lessons l ON l.section_id = s.id
     WHERE s.course_id = ?
     ORDER BY s.order_num ASC, s.id ASC, l.order_num ASC, l.id ASC`,
    [courseId]
  )
  const sections = []
  for (const r of rows) {
    let s = sections.find((x) => x.id === r.section_id)
    if (!s) sections.push((s = { id: r.section_id, title: r.section_title, lessons: [] }))
    if (r.lesson_title) s.lessons.push(r.lesson_title)
  }
  return sections.map(({ title, lessons }) => ({ title, lessons }))
}

/**
 * Validated body (Joi schema `enquiry`) → { ok, syllabus? }.
 * A filled honeypot ("website") is a bot: answer like a success, store nothing.
 */
export const submitEnquiry = async (body, { ip = null, userAgent = null } = {}) => {
  const { kind, name, company, team_size: teamSize, message, preferred_time: preferredTime } = body
  const email = body.email?.trim() || null
  const phone = body.phone?.trim() || null
  if (body.website) return { ok: true }

  if (kind === 'advisor' && !phone) throw fail(400, 'Add a phone number so an advisor can call you')
  if (kind === 'syllabus' && !email) throw fail(400, 'Add your email to get the syllabus')
  if (kind === 'team' && !email && !phone) throw fail(400, 'Add an email or phone number')
  if (kind === 'team' && !company?.trim()) throw fail(400, 'Add your company name')

  let course = null
  if (body.course_id) {
    const [[c]] = await pool.query("SELECT id, title, slug FROM courses WHERE id = ? AND status != 'archived' LIMIT 1", [body.course_id])
    if (!c) throw fail(404, 'Course not found')
    course = c
  }

  const ref = `${kind}-${crypto.randomUUID()}`
  const answers = Object.fromEntries(
    Object.entries({ company, team_size: teamSize, preferred_time: preferredTime, message }).filter(([, v]) => v !== undefined && v !== null && v !== '')
  )
  const lead = {
    name: name.trim(),
    email,
    phone,
    course_id: course?.id ?? null,
    platform_lead_id: ref,
    source_meta: {
      form: KINDS[kind].label,
      page: course ? `/courses/${course.slug}` : undefined,
      answers: Object.keys(answers).length ? answers : undefined,
    },
    consent: { platform: 'website', note: KINDS[kind].note, at: new Date().toISOString(), ip, user_agent: userAgent?.slice(0, 200) ?? null },
  }

  // Never lose the enquiry: it's stored first; if processing hits a temporary
  // problem the queue can retry it from Admin → Integrations.
  const { id } = await recordEvent('website', ref, { lead })
  await processEvent(id).catch((err) => console.error('Enquiry → lead failed (kept for retry):', err.message))

  if (kind === 'team') {
    await notify(await managerIds(), {
      type: 'team_enquiry',
      title: `Team training enquiry from ${company}`,
      body: `${name}${teamSize ? ` · ${teamSize} people` : ''}${course ? ` · ${course.title}` : ''}`,
      link: '/admin/leads',
    })
  }

  if (kind === 'syllabus' && course) {
    const syllabus = await courseSyllabus(course.id)
    await sendSyllabusJob({
      to: email,
      name,
      courseTitle: course.title,
      courseUrl: `${env.frontendUrl}/courses/${course.slug}`,
      sections: syllabus,
    }).catch((err) => console.error('Syllabus email failed:', err.message))
    return { ok: true, syllabus }
  }
  return { ok: true }
}
