// src/modules/seo/seo.service.js
// Search engines and AI crawlers read the HTML of each URL. The site is a React
// app, so its index.html is the same empty shell for every page. This fills the
// shell per URL before it is sent:
//   • <title>, description, canonical, Open Graph / Twitter tags
//   • JSON-LD (Organization, WebSite, Course, BreadcrumbList, ItemList)
//   • the page's main text inside #root, for crawlers that don't run JavaScript
//     (GPTBot, ClaudeBot, PerplexityBot, …). React replaces it when it starts.
//   • noindex on private pages (login, dashboards, checkout)
// Also builds /sitemap.xml, /robots.txt and /llms.txt.

import fs from 'node:fs'
import path from 'node:path'
import { pool } from '../../config/db.js'

const SITE = (process.env.SITE_URL || 'https://certezy.com').replace(/\/+$/, '')
const BRAND = 'Certezy'
// Browser tabs and search results start with the brand in capitals
const TAB = 'CERTEZY'
const ORG_NAME = 'Certezy E-Learning Pvt. Ltd.'
const LOGO = `${SITE}/brand/certezy-logo.png`
const DEFAULT_DESC =
  'Online PMP®, CAPM® and project management certification training from Certezy: video lessons, ' +
  'full-length practice exams, 35 contact hours for PMP® and a verifiable certificate of completion.'

// ── index.html of the built frontend (re-read when it changes) ─────────────
const DIST_CANDIDATES = [
  process.env.FRONTEND_DIST_DIR,
  path.resolve(process.cwd(), '../frontend/dist'),
  path.resolve(process.cwd(), '../certezy_frontend/dist'),
].filter(Boolean)

let shell = { file: null, mtime: 0, html: '' }

export const readShell = () => {
  for (const dir of DIST_CANDIDATES) {
    const file = path.join(dir, 'index.html')
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (shell.file !== file || shell.mtime !== stat.mtimeMs) {
      shell = { file, mtime: stat.mtimeMs, html: fs.readFileSync(file, 'utf8') }
    }
    return shell.html
  }
  return null
}

// ── Helpers ───────────────────────────────────────────────────────────────
export const esc = (s = '') =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

// JSON inside <script> must not be able to close the tag
const jsonLd = (data) =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`

const clean = (s = '') =>
  String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const clip = (s, n = 158) => {
  const t = clean(s)
  if (t.length <= n) return t
  return t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'
}

// "a\nb" or '["a","b"]' → ['a', 'b']
const listOf = (value) => {
  if (!value) return []
  if (Array.isArray(value)) return value.map(clean).filter(Boolean)
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map(clean).filter(Boolean)
  } catch {
    /* plain text */
  }
  return String(value)
    .split(/\r?\n|•/)
    .map((s) => clean(s.replace(/^[-*\d.)\s]+/, '')))
    .filter(Boolean)
}

const hours = (seconds) => Math.max(1, Math.round((Number(seconds) || 0) / 3600))

// ── Data (cached briefly; crawlers can hit many pages at once) ─────────────
const cache = new Map()
const cached = async (key, ms, load) => {
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.value
  const value = await load()
  cache.set(key, { value, until: Date.now() + ms })
  return value
}

const PUBLISHED_COLUMNS = `c.id, c.title, c.slug, c.short_desc, c.description, c.thumbnail,
  c.price, c.pricing_type, c.level, c.language, c.total_duration, c.total_lessons,
  c.rating_avg, c.rating_count, c.certificate_eligible, c.what_you_learn, c.requirements,
  c.created_at, c.updated_at, cat.name AS category_name`

export const publishedCourses = () =>
  cached('courses', 5 * 60e3, async () => {
    const [rows] = await pool.query(
      `SELECT ${PUBLISHED_COLUMNS}
       FROM courses c LEFT JOIN categories cat ON cat.id = c.category_id
       WHERE c.status = 'published'
       ORDER BY c.is_featured DESC, c.enrolled_count DESC, c.id DESC`
    )
    return rows
  })

const courseBySlug = (slug) =>
  cached(`course:${slug}`, 5 * 60e3, async () => {
    const [rows] = await pool.query(
      `SELECT ${PUBLISHED_COLUMNS}
       FROM courses c LEFT JOIN categories cat ON cat.id = c.category_id
       WHERE c.slug = ? AND c.status = 'published' LIMIT 1`,
      [slug]
    )
    const course = rows[0]
    if (!course) return null
    const [sections] = await pool.query(
      `SELECT s.id, s.title, l.title AS lesson_title
       FROM sections s LEFT JOIN lessons l ON l.section_id = s.id
       WHERE s.course_id = ?
       ORDER BY s.order_num, s.id, l.order_num, l.id`,
      [course.id]
    )
    const curriculum = []
    for (const row of sections) {
      let sec = curriculum.at(-1)
      if (!sec || sec.id !== row.id) curriculum.push((sec = { id: row.id, title: row.title, lessons: [] }))
      if (row.lesson_title) sec.lessons.push(row.lesson_title)
    }
    return { ...course, curriculum }
  })

// ── Structured data ───────────────────────────────────────────────────────
const organization = {
  '@type': 'EducationalOrganization',
  '@id': `${SITE}/#organization`,
  name: ORG_NAME,
  alternateName: BRAND,
  url: SITE,
  logo: LOGO,
  address: {
    '@type': 'PostalAddress',
    streetAddress: '3rd Floor, Streamline J-1 Tower, PU-4, Scheme No. 54',
    addressLocality: 'Indore',
    addressRegion: 'Madhya Pradesh',
    postalCode: '452010',
    addressCountry: 'IN',
  },
}

const breadcrumbs = (items) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })),
})

const courseLd = (c) => {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: clean(c.title),
    description: clip(c.description || c.short_desc, 500),
    url: `${SITE}/courses/${c.slug}`,
    provider: { '@type': 'Organization', name: ORG_NAME, sameAs: SITE },
    inLanguage: c.language === 'Hindi' ? 'hi' : 'en',
    educationalLevel: c.level,
    isAccessibleForFree: c.pricing_type === 'free',
    offers: {
      '@type': 'Offer',
      category: c.pricing_type === 'free' ? 'Free' : 'Paid',
      price: Number(c.price) || 0,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: `${SITE}/courses/${c.slug}`,
    },
    hasCourseInstance: {
      '@type': 'CourseInstance',
      courseMode: 'Online',
      courseWorkload: `PT${hours(c.total_duration)}H`,
    },
  }
  if (c.thumbnail) data.image = c.thumbnail
  const learn = listOf(c.what_you_learn)
  if (learn.length) data.teaches = learn.slice(0, 20)
  const req = listOf(c.requirements)
  if (req.length) data.coursePrerequisites = req.slice(0, 10)
  // Only real student reviews (Google ignores / penalises made-up ratings)
  if (Number(c.rating_count) > 0) {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(c.rating_avg),
      ratingCount: Number(c.rating_count),
      bestRating: 5,
    }
  }
  return data
}

// ── Page bodies (plain, semantic HTML for crawlers) ───────────────────────
const nav = `<nav><a href="/">Home</a> · <a href="/courses">Courses</a> · <a href="/about">About us</a> · <a href="/contact-us">Contact us</a></nav>`

const courseLinks = (courses) =>
  `<ul>${courses
    .map(
      (c) =>
        `<li><a href="/courses/${esc(c.slug)}">${esc(clean(c.title))}</a>${
          c.short_desc ? ` — ${esc(clip(c.short_desc, 160))}` : ''
        }</li>`
    )
    .join('')}</ul>`

const STATIC_PAGES = {
  '/about': {
    title: `${TAB} | About Us — Project Management Certification Training`,
    description:
      'Certezy E-Learning Pvt. Ltd. (Indore, India) offers online PMP®, CAPM® and project management courses with practice exams and verifiable certificates.',
    heading: `About ${BRAND}`,
    text: 'Certezy E-Learning Pvt. Ltd. is an online learning company based in Indore, India. We help professionals prepare for project management certifications such as PMP® and CAPM® with video lessons, practice exams that mirror the real test, and certificates of completion that can be verified online.',
  },
  '/contact-us': {
    title: `${TAB} | Contact Us — WhatsApp, Email & Office Address`,
    description:
      'Contact Certezy E-Learning Pvt. Ltd.: WhatsApp support 24/7 for India and the US, email, and our office at Streamline J-1 Tower, Indore, Madhya Pradesh.',
    heading: 'Contact us',
    text: 'Certezy E-Learning Pvt. Ltd., 3rd Floor, Streamline J-1 Tower, PU-4, Scheme No. 54, Indore, Madhya Pradesh 452010, India. Chat with us on WhatsApp 24/7 or send us a message.',
  },
  '/privacy-policy': {
    title: `${TAB} | Privacy Policy`,
    description: 'How Certezy E-Learning Pvt. Ltd. collects, uses and protects your personal data.',
    heading: 'Privacy Policy',
  },
  '/terms-of-service': {
    title: `${TAB} | Terms of Service`,
    description: 'The terms that apply when you use Certezy courses, practice exams and certificates.',
    heading: 'Terms of Service',
  },
  '/verify': {
    title: `${TAB} | Verify a Certificate`,
    description:
      'Check that a Certezy certificate of completion is genuine by entering its certificate number.',
    heading: 'Verify a certificate',
  },
}

// Private or one-off pages: rendered by the app, kept out of search results
const NOINDEX = [
  /^\/(login|register|change-password|checkout|forgot-password|reset-password)(\/|$)/,
  /^\/(student|admin|oauth|payment|offer)(\/|$)/,
  /^\/verify\/.+/,
]

/**
 * Meta + body for a URL path. `status` is 404 for unknown pages and courses
 * that don't exist (the app still loads and shows its own "not found").
 */
export const pageFor = async (rawPath) => {
  const p = (rawPath.split(/[?#]/)[0] || '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
  const canonical = `${SITE}${p === '/' ? '/' : p}`
  const base = { status: 200, canonical, image: LOGO, ld: [], noindex: false }

  if (NOINDEX.some((re) => re.test(p))) {
    return { ...base, title: TAB, description: DEFAULT_DESC, noindex: true, body: '' }
  }

  if (p === '/') {
    const courses = await publishedCourses()
    return {
      ...base,
      title: `${TAB} | PMP® & Project Management Certification Training Online`,
      description: DEFAULT_DESC,
      ld: [
        { '@context': 'https://schema.org', ...organization },
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: BRAND,
          url: SITE,
          publisher: { '@id': `${SITE}/#organization` },
        },
      ],
      body:
        `<h1>Project management certification training: PMP®, CAPM® and more</h1>` +
        `<p>${esc(DEFAULT_DESC)}</p><h2>Courses</h2>${courseLinks(courses)}`,
    }
  }

  if (p === '/courses') {
    const courses = await publishedCourses()
    return {
      ...base,
      title: `${TAB} | All Courses — PMP®, CAPM®, Agile & Project Management`,
      description: `Browse ${courses.length} online courses from Certezy: certification exam prep, practice tests and certificates of completion.`,
      ld: [
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          itemListElement: courses.map((c, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: `${SITE}/courses/${c.slug}`,
            name: clean(c.title),
          })),
        },
        breadcrumbs([
          ['Home', `${SITE}/`],
          ['Courses', `${SITE}/courses`],
        ]),
      ],
      body: `<h1>All courses</h1>${courseLinks(courses)}`,
    }
  }

  const courseMatch = p.match(/^\/courses\/([^/]+)$/)
  if (courseMatch) {
    let slug
    try {
      slug = decodeURIComponent(courseMatch[1])
    } catch {
      slug = courseMatch[1]
    }
    const c = await courseBySlug(slug)
    if (!c) {
      return {
        ...base,
        status: 404,
        title: `${TAB} | Course not found`,
        description: DEFAULT_DESC,
        noindex: true,
        body: '',
      }
    }
    const title = clean(c.title)
    const learn = listOf(c.what_you_learn)
    const facts = [
      c.total_lessons ? `${c.total_lessons} lessons` : null,
      c.total_duration ? `${hours(c.total_duration)} hours of content` : null,
      c.level ? `${c.level} level` : null,
      c.language || null,
      c.certificate_eligible ? 'certificate of completion' : null,
    ].filter(Boolean)
    return {
      ...base,
      title: `${TAB} | ${title}`,
      description: clip(c.short_desc || c.description) || DEFAULT_DESC,
      image: c.thumbnail || LOGO,
      type: 'website',
      ld: [
        courseLd(c),
        breadcrumbs([
          ['Home', `${SITE}/`],
          ['Courses', `${SITE}/courses`],
          [title, canonical],
        ]),
      ],
      body:
        `<h1>${esc(title)}</h1>` +
        (facts.length ? `<p>${esc(facts.join(' · '))}</p>` : '') +
        `<p>${esc(clean(c.description || c.short_desc))}</p>` +
        (learn.length
          ? `<h2>What you'll learn</h2><ul>${learn.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
          : '') +
        (c.curriculum.length
          ? `<h2>Course content</h2>` +
            c.curriculum
              .map(
                (s) =>
                  `<h3>${esc(clean(s.title))}</h3>` +
                  (s.lessons.length
                    ? `<ul>${s.lessons.map((l) => `<li>${esc(clean(l))}</li>`).join('')}</ul>`
                    : '')
              )
              .join('')
          : '') +
        `<p><a href="/courses/${esc(c.slug)}">Enroll in ${esc(title)}</a></p>`,
    }
  }

  const page = STATIC_PAGES[p]
  if (page) {
    return {
      ...base,
      title: page.title,
      description: page.description,
      ld:
        p === '/about' || p === '/contact-us' ? [{ '@context': 'https://schema.org', ...organization }] : [],
      body: `<h1>${esc(page.heading)}</h1>${page.text ? `<p>${esc(page.text)}</p>` : ''}`,
    }
  }

  return {
    ...base,
    status: 404,
    title: `${TAB} | Page not found`,
    description: DEFAULT_DESC,
    noindex: true,
    body: '',
  }
}

// ── Put the page into the shell ───────────────────────────────────────────
export const renderShell = (html, page) => {
  const head = [
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}" />`,
    page.noindex
      ? `<meta name="robots" content="noindex, follow" />`
      : `<meta name="robots" content="index, follow, max-image-preview:large" />`,
    page.noindex ? '' : `<link rel="canonical" href="${esc(page.canonical)}" />`,
    `<meta property="og:site_name" content="${BRAND}" />`,
    `<meta property="og:type" content="${page.type || 'website'}" />`,
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${esc(page.canonical)}" />`,
    `<meta property="og:image" content="${esc(page.image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(page.title)}" />`,
    `<meta name="twitter:description" content="${esc(page.description)}" />`,
    `<meta name="twitter:image" content="${esc(page.image)}" />`,
    ...page.ld.map(jsonLd),
  ]
    .filter(Boolean)
    .join('\n    ')

  let out = html
    // drop the shell's generic tags; the page's own replace them
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name="description"[^>]*>\s*/gi, '')
    .replace(/<meta\s+property="og:(title|image|description|url|type)"[^>]*>\s*/gi, '')
    .replace(/<\/head>/i, `    ${head}\n  </head>`)

  if (page.body) {
    // Shown only if the app hasn't started after a few seconds; crawlers that
    // don't run JavaScript read it straight from the HTML. React replaces it.
    const fallback =
      `<style>#seo-fallback{opacity:0;animation:seo-show 0s 4s forwards;max-width:860px;margin:0 auto;padding:24px;` +
      `font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:#0f172a;line-height:1.6}` +
      `#seo-fallback a{color:#2875AC}@keyframes seo-show{to{opacity:1}}</style>` +
      `<div id="seo-fallback">${nav}<main>${page.body}</main>` +
      `<footer><p>© ${ORG_NAME}</p></footer></div>`
    out = out.replace(/<div id="root"><\/div>/, `<div id="root">${fallback}</div>`)
  }
  return out
}

// ── sitemap.xml / robots.txt / llms.txt ───────────────────────────────────
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined)

export const sitemapXml = async () => {
  const courses = await publishedCourses()
  const newest = courses.reduce(
    (m, c) => Math.max(m, new Date(c.updated_at || c.created_at).getTime() || 0),
    0
  )
  const urls = [
    { loc: `${SITE}/`, lastmod: newest ? isoDate(newest) : undefined, priority: '1.0' },
    { loc: `${SITE}/courses`, lastmod: newest ? isoDate(newest) : undefined, priority: '0.9' },
    ...courses.map((c) => ({
      loc: `${SITE}/courses/${encodeURIComponent(c.slug)}`,
      lastmod: isoDate(c.updated_at || c.created_at),
      priority: '0.8',
    })),
    ...['/about', '/contact-us', '/verify', '/privacy-policy', '/terms-of-service'].map((p) => ({
      loc: `${SITE}${p}`,
      priority: '0.4',
    })),
  ]
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`
      )
      .join('\n') +
    `\n</urlset>\n`
  )
}

export const robotsTxt = () =>
  [
    '# Search engines and AI assistants are welcome to read and cite public pages.',
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /student',
    'Disallow: /checkout',
    'Disallow: /payment/',
    'Disallow: /offer/',
    'Disallow: /oauth/',
    'Disallow: /api/',
    '',
    '# AI search and assistant crawlers (allowed explicitly)',
    ...[
      'GPTBot',
      'OAI-SearchBot',
      'ChatGPT-User',
      'ClaudeBot',
      'Claude-User',
      'PerplexityBot',
      'Google-Extended',
      'Applebot-Extended',
      'Bingbot',
    ].flatMap((bot) => [
      `User-agent: ${bot}`,
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /student',
      'Disallow: /checkout',
      'Disallow: /api/',
      '',
    ]),
    `Sitemap: ${SITE}/sitemap.xml`,
    '',
  ].join('\n')

export const llmsTxt = async () => {
  const courses = await publishedCourses()
  return [
    `# ${ORG_NAME} (${BRAND})`,
    '',
    `> ${DEFAULT_DESC}`,
    '',
    'Based in Indore, Madhya Pradesh, India. Courses are online and self-paced.',
    '',
    '## Courses',
    ...courses.map(
      (c) =>
        `- [${clean(c.title)}](${SITE}/courses/${c.slug})${c.short_desc ? `: ${clip(c.short_desc, 200)}` : ''}`
    ),
    '',
    '## Company',
    `- [About us](${SITE}/about)`,
    `- [Contact us](${SITE}/contact-us)`,
    `- [Verify a certificate](${SITE}/verify)`,
    `- [Privacy policy](${SITE}/privacy-policy)`,
    `- [Terms of service](${SITE}/terms-of-service)`,
    '',
  ].join('\n')
}
