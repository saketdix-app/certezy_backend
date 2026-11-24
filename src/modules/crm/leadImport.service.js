// src/modules/crm/leadImport.service.js
// Upload leads from a CSV file (Admin → Leads / consultant workspace → Import CSV).
//   • Columns are recognised by their header (many common names, including the
//     Facebook / Meta Leads export); anything not recognised is kept on the lead
//     (source_meta.answers) so nothing in the file is lost.
//   • Rows need a phone or an email. People already in the CRM, or twice in the
//     file, are skipped and listed.
//   • dry_run checks the file and shows what would happen; nothing is created.
//   • Admins / Sub-Admins with CRM access import for anyone (assigning needs
//     "Lead assignment"); consultants import leads for themselves.

import { parse } from 'csv-parse/sync'
import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { notify } from '../../utils/notify.js'
import { canAssignLeads, isCrmManager } from '../../utils/access.js'
import { SOURCES, STAGE_LABELS } from './crm.constants.js'
import { normalizeEmail, normalizePhone } from './leads.service.js'
import { autoAssign } from './distribution.service.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
export const MAX_ROWS = 10000
const PREVIEW_ROWS = 50
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Stages an import may set (later stages need a ticket size, exam date or payment)
const IMPORTABLE_STAGES = ['backlog', 'new', 'attempting_contact', 'in_conversation', 'no_response', 'on_hold', 'not_interested', 'junk']
const CHUNK = 1000 // rows per batched lookup / insert

/** "Phone Number" → "phonenumber" */
const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Field ← header names it is recognised by (normalised). First match wins. */
const SYNONYMS = {
  name: ['name', 'fullname', 'leadname', 'contactname', 'customername', 'studentname', 'candidatename', 'clientname'],
  first_name: ['firstname', 'fname', 'givenname'],
  last_name: ['lastname', 'lname', 'surname', 'familyname'],
  email: ['email', 'emailaddress', 'emailid', 'mail', 'workemail', 'personalemail'],
  phone: [
    'phone', 'phonenumber', 'phoneno', 'mobile', 'mobilenumber', 'mobileno', 'contact', 'contactnumber', 'contactno',
    'whatsapp', 'whatsappnumber', 'whatsappno', 'cell', 'cellphone', 'telephone', 'tel',
  ],
  course: ['course', 'coursename', 'program', 'programme', 'programname', 'interestedcourse', 'interestedin', 'courseinterest', 'certification', 'interest'],
  source: ['source', 'leadsource', 'channel', 'platform'],
  campaign: ['campaign', 'campaignname'],
  ad: ['ad', 'adname'],
  form: ['form', 'formname'],
  utm_source: ['utmsource'],
  utm_medium: ['utmmedium'],
  utm_campaign: ['utmcampaign'],
  preferred_schedule: ['preferredtime', 'preferredschedule', 'besttimetocall', 'callbacktime', 'preferredcalltime', 'timetocall'],
  owner: ['owner', 'leadowner', 'assignedto', 'assignee', 'consultant', 'counsellor', 'counselor', 'salesperson', 'agent'],
  stage: ['stage', 'status', 'leadstatus', 'leadstage'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comment', 'comments', 'message', 'query', 'description', 'requirement'],
  platform_lead_id: ['id', 'leadid'],
}
const FIELD_OF = new Map()
for (const [field, names] of Object.entries(SYNONYMS)) for (const n of names) if (!FIELD_OF.has(n)) FIELD_OF.set(n, field)

export const FIELD_LABELS = {
  name: 'Name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  course: 'Course',
  source: 'Source',
  campaign: 'Campaign',
  ad: 'Ad',
  form: 'Form',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  preferred_schedule: 'Preferred time',
  owner: 'Owner (consultant)',
  stage: 'Stage',
  notes: 'Notes',
  platform_lead_id: 'Lead ID',
  extra: 'Kept on the lead',
}

/** Header → field (each field used once; the rest are kept as extra answers). */
export const detectColumns = (headers) => {
  const used = new Set()
  return headers.map((header) => {
    const field = FIELD_OF.get(norm(header))
    if (field && !used.has(field)) {
      used.add(field)
      return { header, field }
    }
    return { header, field: 'extra' }
  })
}

/** "Facebook" / "ig" / "LinkedIn Ads" → one of SOURCES. */
export const mapSource = (value, fallback = 'manual') => {
  const v = norm(value)
  if (!v) return fallback
  if (/^(fb|facebook|instagram|ig|meta)/.test(v) || v.includes('facebook') || v.includes('instagram')) return 'meta'
  if (v.includes('linkedin')) return 'linkedin'
  if (v.includes('whatsapp')) return 'whatsapp'
  if (v.includes('referr') || v.includes('reference')) return 'referral'
  if (/^(web|website|site|google|organic|seo|landingpage)/.test(v) || v.includes('website')) return 'website'
  if (/^(manual|walkin|call|phone|offline|event)/.test(v)) return 'manual'
  return SOURCES.includes(v) ? v : 'other'
}

const stageFrom = (value) => {
  const v = norm(value)
  if (!v) return { stage: 'new' }
  for (const [key, label] of Object.entries(STAGE_LABELS)) {
    if (norm(key) === v || norm(label) === v || norm(label.replace(/ Leads?$/, '')) === v) {
      return IMPORTABLE_STAGES.includes(key)
        ? { stage: key }
        : { stage: 'new', issue: `Stage "${value}" can't be imported (needs ticket size / exam / payment) — added as New` }
    }
  }
  return { stage: 'new', issue: `Unknown stage "${value}" — added as New` }
}

const parseCsv = (csv) => {
  let rows
  try {
    rows = parse(String(csv ?? ''), { bom: true, skip_empty_lines: true, trim: true, relax_column_count: true })
  } catch (err) {
    throw fail(400, `This doesn't look like a CSV file: ${err.message}`)
  }
  if (rows.length < 2) throw fail(400, 'The file needs a header row and at least one lead')
  const [headers, ...data] = rows
  if (data.length > MAX_ROWS) throw fail(400, `Up to ${MAX_ROWS} leads per file — split the file and import the parts`)
  return { headers: headers.map((h) => String(h ?? '').trim()), data }
}

/** Courses by id / slug / title, for the "course" column. */
const courseMatcher = async () => {
  const [courses] = await pool.query("SELECT id, title, slug FROM courses WHERE status != 'archived'")
  return (value) => {
    const v = String(value ?? '').trim().toLowerCase()
    if (!v) return null
    return (
      courses.find((c) => String(c.id) === v || c.slug?.toLowerCase() === v || c.title?.toLowerCase() === v) ??
      courses.find((c) => c.title?.toLowerCase().includes(v) || v.includes(c.title?.toLowerCase() ?? '\u0000')) ??
      null
    )
  }
}

/** Active staff by name or email, for the "owner" column. */
const ownerMatcher = async () => {
  const [people] = await pool.query(
    `SELECT id, name, email, role FROM users
     WHERE is_active = 1 AND deleted_at IS NULL AND role IN ('consultant', 'admin', 'super_admin')`
  )
  return (value) => {
    const v = String(value ?? '').trim().toLowerCase()
    if (!v) return null
    return people.find((p) => p.email?.toLowerCase() === v) ?? people.find((p) => p.name?.trim().toLowerCase() === v) ?? null
  }
}

/** Turn one CSV row into a lead (or the reasons it can't be one). */
const buildRow = (cells, columns, ctx) => {
  const get = (field) => {
    const i = columns.findIndex((c) => c.field === field)
    return i >= 0 ? String(cells[i] ?? '').trim() : ''
  }
  const issues = []
  const email = get('email').toLowerCase()
  const phone = get('phone').replace(/^p:/i, '') // Facebook prefixes phone numbers with "p:"
  let name = get('name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ')
  if (!name && email) name = email.split('@')[0]

  const errors = []
  if (!phone && !email) errors.push('No phone or email')
  if (email && !EMAIL_RE.test(email)) errors.push(`Email "${email}" isn't valid`)
  if (phone && !normalizePhone(phone)) errors.push(`Phone "${phone}" is too short`)
  if (!name || name.length < 2) errors.push('No name')

  const source = get('source') ? mapSource(get('source'), ctx.defaultSource) : ctx.defaultSource
  const courseCell = get('course')
  let course = ctx.defaultCourse
  if (courseCell) {
    const found = ctx.findCourse(courseCell)
    if (found) course = found
    else issues.push(`Course "${courseCell}" not found${ctx.defaultCourse ? ' — default course used' : ''}`)
  }
  const { stage, issue: stageIssue } = stageFrom(get('stage'))
  if (stageIssue) issues.push(stageIssue)

  let owner = null
  if (ctx.ownerMode === 'column' && get('owner')) {
    owner = ctx.findOwner(get('owner'))
    if (!owner) issues.push(`Owner "${get('owner')}" not found — left unassigned`)
  }

  const answers = {}
  columns.forEach((c, i) => {
    const v = String(cells[i] ?? '').trim()
    if (!v) return
    if (c.field === 'extra' || (c.field === 'owner' && ctx.ownerMode !== 'column')) answers[c.header] = v.slice(0, 500)
  })
  if (get('source') && source === 'other') answers.source_detail = get('source').slice(0, 150)
  const meta = Object.fromEntries(
    ['campaign', 'ad', 'form', 'utm_source', 'utm_medium', 'utm_campaign'].map((k) => [k, get(k).slice(0, 150)]).filter(([, v]) => v)
  )
  const sourceMeta = { ...meta, form: meta.form || 'CSV import', ...(Object.keys(answers).length && { answers }) }

  return {
    errors,
    issues,
    lead: {
      name: name.slice(0, 150),
      email: email || null,
      phone: phone ? phone.slice(0, 30) : null,
      source,
      course_id: course?.id ?? null,
      course_title: course?.title ?? null,
      preferred_schedule: get('preferred_schedule').slice(0, 150) || null,
      platform_lead_id: get('platform_lead_id').slice(0, 100) || null,
      stage,
      notes: get('notes').slice(0, 5000) || null,
      owner,
      source_meta: sourceMeta,
    },
  }
}

const OWNER_MODES = ['me', 'unassigned', 'owner', 'round_robin', 'column']

const chunks = (list, n = CHUNK) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n))

/**
 * Existing leads matching the file's phones, emails and platform ids, in a few
 * batched queries (not one per row — files can have 10,000 leads).
 */
const existingLeads = async (rows) => {
  const phones = new Set()
  const emails = new Set()
  const pids = new Set()
  for (const r of rows) {
    const p = normalizePhone(r.lead.phone)
    const e = normalizeEmail(r.lead.email)
    if (p) phones.add(p)
    if (e) emails.add(e)
    if (r.lead.platform_lead_id) pids.add(String(r.lead.platform_lead_id))
  }
  const byPhone = new Map()
  const byEmail = new Map()
  const byPid = new Map()
  const run = async (column, values, into, key) => {
    for (const part of chunks([...values])) {
      const [found] = await pool.query(
        `SELECT l.id, l.name, l.owner_id, l.phone_norm, l.email_norm, l.source, l.platform_lead_id
         FROM leads l WHERE l.archived_at IS NULL AND l.${column} IN (?)`,
        [part]
      )
      for (const f of found) if (!into.has(key(f))) into.set(key(f), f)
    }
  }
  await run('phone_norm', phones, byPhone, (f) => f.phone_norm)
  await run('email_norm', emails, byEmail, (f) => f.email_norm)
  await run('platform_lead_id', pids, byPid, (f) => `${f.source}|${f.platform_lead_id}`)
  return (lead) =>
    byPhone.get(normalizePhone(lead.phone)) ??
    byEmail.get(normalizeEmail(lead.email)) ??
    (lead.platform_lead_id ? byPid.get(`${lead.source}|${lead.platform_lead_id}`) : undefined) ??
    null
}

/** Student accounts for the file's emails (link the lead to its student). */
const studentIds = async (rows) => {
  const emails = [...new Set(rows.map((r) => normalizeEmail(r.lead.email)).filter(Boolean))]
  const map = new Map()
  for (const part of chunks(emails)) {
    const [found] = await pool.query('SELECT id, LOWER(email) AS e FROM users WHERE LOWER(email) IN (?) AND deleted_at IS NULL', [part])
    for (const f of found) if (!map.has(f.e)) map.set(f.e, f.id)
  }
  return map
}

/**
 * Check (dry_run) or import a CSV of leads.
 * body: { csv, dry_run, default_source, course_id, owner_mode, owner_id }
 */
export const importLeads = async (req, body) => {
  const actor = req.user
  const manager = isCrmManager(actor)
  if (!manager && actor?.role !== 'consultant') throw fail(403, 'Importing leads is for consultants and admins')
  // Consultants import for themselves only
  const ownerMode = manager ? (OWNER_MODES.includes(body.owner_mode) ? body.owner_mode : 'unassigned') : 'me'
  if (['owner', 'round_robin', 'column'].includes(ownerMode) && !canAssignLeads(actor)) {
    throw fail(403, 'Assigning leads needs the "Lead assignment" permission — import them unassigned or to yourself')
  }
  let fixedOwner = null
  if (ownerMode === 'owner') {
    const [[u]] = await pool.query(
      `SELECT id, name, role FROM users WHERE id = ? AND is_active = 1 AND deleted_at IS NULL
         AND role IN ('consultant', 'admin', 'super_admin') LIMIT 1`,
      [body.owner_id ?? 0]
    )
    if (!u) throw fail(400, 'Choose an active consultant to assign the leads to')
    fixedOwner = u
  }

  const { headers, data } = parseCsv(body.csv)
  const columns = detectColumns(headers)
  if (!columns.some((c) => c.field === 'phone' || c.field === 'email')) {
    throw fail(400, 'No phone or email column found. Name a column "Phone" or "Email" (see the sample CSV).')
  }

  let defaultCourse = null
  if (body.course_id) {
    const [[c]] = await pool.query("SELECT id, title FROM courses WHERE id = ? AND status != 'archived' LIMIT 1", [body.course_id])
    if (!c) throw fail(400, 'Default course not found')
    defaultCourse = c
  }
  const ctx = {
    defaultSource: SOURCES.includes(body.default_source) ? body.default_source : 'manual',
    defaultCourse,
    ownerMode,
    findCourse: columns.some((c) => c.field === 'course') ? await courseMatcher() : () => null,
    findOwner: ownerMode === 'column' ? await ownerMatcher() : () => null,
  }

  // Check every row: errors, then duplicates (in the CRM, then earlier in this file)
  const built = data.map((cells, i) => ({ row: i + 2, ...buildRow(cells, columns, ctx) }))
  // Backlog: the whole upload waits in the consultant's Backlog tab
  if (body.as_backlog) for (const r of built) if (!r.errors.length) r.lead.stage = 'backlog'
  const findExisting = await existingLeads(built.filter((r) => !r.errors.length))
  const seenPhones = new Set()
  const seenEmails = new Set()
  const rows = []
  for (const r of built) {
    const out = r
    if (r.errors.length) out.status = 'error'
    else {
      const p = normalizePhone(r.lead.phone)
      const e = normalizeEmail(r.lead.email)
      if ((p && seenPhones.has(p)) || (e && seenEmails.has(e))) {
        out.status = 'duplicate'
        out.issues = [...r.issues, 'Same person appears earlier in this file']
      } else {
        const d = findExisting(r.lead)
        if (d) {
          out.status = 'duplicate'
          out.issues = [...r.issues, manager || d.owner_id === actor.id ? `Already a lead: ${d.name} (#${d.id})` : 'Already a lead (another consultant)']
        } else out.status = 'ready'
      }
      if (p) seenPhones.add(p)
      if (e) seenEmails.add(e)
    }
    rows.push(out)
  }
  const count = (s) => rows.filter((r) => r.status === s).length
  const summary = {
    mapping: columns.map((c) => ({ ...c, label: FIELD_LABELS[c.field] })),
    total: rows.length,
    ready: count('ready'),
    duplicates: count('duplicate'),
    errors: count('error'),
    owner_mode: ownerMode,
    as_backlog: Boolean(body.as_backlog),
  }
  const view = (r) => ({
    row: r.row,
    status: r.status,
    name: r.lead.name,
    phone: r.lead.phone,
    email: r.lead.email,
    source: r.lead.source,
    course: r.lead.course_title,
    stage: r.lead.stage,
    owner: r.lead.owner?.name ?? (ownerMode === 'owner' ? fixedOwner?.name : ownerMode === 'me' ? actor.name : null) ?? null,
    issues: [...r.errors, ...r.issues],
  })

  if (body.dry_run) {
    // Problems first, so they are easy to see
    const ordered = [...rows.filter((r) => r.status !== 'ready'), ...rows.filter((r) => r.status === 'ready')]
    return { ...summary, dry_run: true, rows: ordered.slice(0, PREVIEW_ROWS).map(view) }
  }

  // ── Import ──
  // One transaction (fast for thousands of rows); activities in batched inserts
  const ready = rows.filter((x) => x.status === 'ready')
  const students = await studentIds(ready)
  const created = []
  const perOwner = new Map()
  const activities = []
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    for (const r of ready) {
      const l = r.lead
      const ownerId = ownerMode === 'me' ? actor.id : ownerMode === 'owner' ? fixedOwner.id : ownerMode === 'column' ? l.owner?.id ?? null : null
      // Backlog leads aren't "new" for the red dot: the consultant picks them up when they have time
      const seen = ownerId && l.stage === 'backlog'
      const [res] = await conn.query(
        `INSERT INTO leads (name, phone, phone_norm, email, email_norm, course_id, preferred_schedule, source,
           source_meta, platform_lead_id, consent, owner_id, assigned_by, assigned_at, owner_seen_at, stage, stage_changed_at,
           user_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ${ownerId ? 'UTC_TIMESTAMP()' : 'NULL'}, ${seen ? 'UTC_TIMESTAMP()' : 'NULL'}, ?, UTC_TIMESTAMP(), ?, ?)`,
        [
          l.name,
          l.phone,
          normalizePhone(l.phone),
          l.email,
          normalizeEmail(l.email),
          l.course_id,
          l.preferred_schedule,
          l.source,
          JSON.stringify(l.source_meta),
          l.platform_lead_id,
          ownerId,
          ownerId ? actor.id : null,
          l.stage,
          students.get(normalizeEmail(l.email)) ?? null,
          actor.id,
        ]
      )
      const id = res.insertId
      created.push(id)
      activities.push([id, actor.id, 'created', null, JSON.stringify({ source: l.source, import: true, ...(l.stage === 'backlog' && { backlog: true }) })])
      if (ownerId) {
        activities.push([id, actor.id, 'assignment', null, JSON.stringify({ to: ownerId, how: 'import' })])
        if (ownerId !== actor.id) perOwner.set(ownerId, (perOwner.get(ownerId) ?? 0) + 1)
      }
      if (l.notes) activities.push([id, actor.id, 'note', l.notes, JSON.stringify({ from: 'import' })])
    }
    for (const part of chunks(activities)) {
      await conn.query('INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES ?', [part])
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  // Round Robin after the import is saved (each lead goes through the usual rules)
  let roundRobinAssigned = 0
  if (ownerMode === 'round_robin') {
    for (const id of created) {
      const a = await autoAssign(id, { req }).catch(() => ({}))
      if (a?.assigned_to) roundRobinAssigned++
    }
  }

  // One notification per person, not one per lead
  for (const [ownerId, n] of perOwner) {
    await notify(ownerId, {
      type: 'lead_assigned',
      title: body.as_backlog
        ? `${n} lead${n === 1 ? '' : 's'} added to your Backlog`
        : n === 1
          ? 'A lead was assigned to you from an import'
          : `${n} leads were assigned to you from an import`,
      body: body.as_backlog ? `Imported by ${actor.name ?? 'an admin'} — move them to Attempting Contact when you have time` : `Imported by ${actor.name ?? 'an admin'}`,
      link: '/consultant/leads',
    })
  }
  await audit(req, {
    action: 'lead.import',
    targetType: 'lead',
    details: {
      total: rows.length,
      created: created.length,
      skipped_duplicates: summary.duplicates,
      errors: summary.errors,
      owner_mode: ownerMode,
      owner_id: fixedOwner?.id,
      as_backlog: Boolean(body.as_backlog),
    },
  })
  return {
    ...summary,
    dry_run: false,
    created: created.length,
    skipped_duplicates: summary.duplicates,
    assigned: {
      to_owners: [...perOwner.values()].reduce((a, b) => a + b, 0) + (ownerMode === 'me' ? created.length : 0),
      round_robin: roundRobinAssigned,
    },
    rows: rows.filter((r) => r.status !== 'ready').slice(0, PREVIEW_ROWS).map(view),
  }
}
