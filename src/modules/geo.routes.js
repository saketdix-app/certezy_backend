// src/modules/geo.routes.js
// GET /geo → { country, currency } for the visitor's IP (public, no cache).

import { Router } from 'express'
import { success } from '../utils/response.js'
import { regionForRequest } from '../utils/geo.js'

const router = Router()

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store')
  return success(res, { message: 'Region detected', data: regionForRequest(req) })
})

export default router
