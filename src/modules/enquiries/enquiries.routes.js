// src/modules/enquiries/enquiries.routes.js
// Public: POST /api/v1/enquiries — course-page lead forms (rate-limited).

import { Router } from 'express'
import { validate, schemas } from '../../middleware/validate.js'
import { enquiryLimiter } from '../../middleware/rateLimit.js'
import { success } from '../../utils/response.js'
import { submitEnquiry } from './enquiries.service.js'

const router = Router()

router.post('/', enquiryLimiter, validate(schemas.enquiry), async (req, res, next) => {
  try {
    const data = await submitEnquiry(req.body, { ip: req.ip, userAgent: req.get('user-agent') })
    return success(res, { message: 'Thanks — we\'ll be in touch shortly', data })
  } catch (err) {
    next(err)
  }
})

export default router
