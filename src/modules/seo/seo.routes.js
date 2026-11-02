// src/modules/seo/seo.routes.js
// Mounted at the site root (not under /api), before helmet: these answer
// crawlers and browsers with HTML / XML / text, not JSON.
//
//   GET /robots.txt, /sitemap.xml, /llms.txt
//   GET /__seo/page   — index.html filled in for the URL in X-Original-URI
//                       (nginx sends every page URL that isn't a static file here)

import { Router } from 'express'
import { readShell, pageFor, renderShell, sitemapXml, robotsTxt, llmsTxt } from './seo.service.js'

const router = Router()

const send = (res, type, body, maxAge = 3600) => {
  res.type(type)
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`)
  res.send(body)
}

router.get('/robots.txt', (req, res) => send(res, 'text/plain; charset=utf-8', robotsTxt(), 86400))

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    send(res, 'application/xml; charset=utf-8', await sitemapXml())
  } catch (err) {
    next(err)
  }
})

router.get('/llms.txt', async (req, res, next) => {
  try {
    send(res, 'text/plain; charset=utf-8', await llmsTxt())
  } catch (err) {
    next(err)
  }
})

router.get('/__seo/page', async (req, res) => {
  const shell = readShell()
  // nginx falls back to the static index.html on 5xx
  if (!shell) return res.status(503).type('text/plain').send('Frontend build not found')

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.type('html')
  const url = String(req.get('x-original-uri') || req.query.path || '/')
  try {
    const page = await pageFor(url)
    return res.status(page.status).send(renderShell(shell, page))
  } catch (err) {
    // database down etc. — the app still works without the extra tags
    console.error(`SEO render failed for ${url}: ${err.message}`)
    return res.status(200).send(shell)
  }
})

export default router
