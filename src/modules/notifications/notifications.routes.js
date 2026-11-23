// src/modules/notifications/notifications.routes.js
// In-app notifications for the signed-in user (2.0).

import { Router } from 'express'
import authenticate from '../../middleware/auth.js'
import { pool } from '../../config/db.js'
import { success } from '../../utils/response.js'
import { validate, schemas } from '../../middleware/validate.js'
import { registerDevice, removeDevice } from '../../utils/push.js'

const router = Router()

// GET /notifications → latest 30 and the unread count
router.get('/', authenticate, async (req, res, next) => {
  try {
    const [items] = await pool.query(
      `SELECT id, type, title, body, link, read_at, created_at FROM user_notifications
       WHERE user_id = ? ORDER BY id DESC LIMIT 30`,
      [req.user.id]
    )
    const [[{ unread }]] = await pool.query(
      'SELECT COUNT(*) AS unread FROM user_notifications WHERE user_id = ? AND read_at IS NULL',
      [req.user.id]
    )
    return success(res, { data: { items, unread: Number(unread) } })
  } catch (err) {
    next(err)
  }
})

// PUT /notifications/read → mark all (or one, ?id=) as read
router.put('/read', authenticate, async (req, res, next) => {
  try {
    const id = Number(req.query.id) || null
    await pool.query(
      `UPDATE user_notifications SET read_at = UTC_TIMESTAMP() WHERE user_id = ? AND read_at IS NULL ${id ? 'AND id = ?' : ''}`,
      id ? [req.user.id, id] : [req.user.id]
    )
    return success(res, { message: 'Marked as read' })
  } catch (err) {
    next(err)
  }
})

// POST /notifications/devices { token, platform, device_name } — the Team app's push token
router.post('/devices', authenticate, validate(schemas.pushDevice), async (req, res, next) => {
  try {
    await registerDevice(req.user.id, req.body)
    return success(res, { message: 'Device registered' })
  } catch (err) {
    next(err)
  }
})

// DELETE /notifications/devices { token } — signed out on that phone
router.delete('/devices', authenticate, validate(schemas.pushDeviceRemove), async (req, res, next) => {
  try {
    await removeDevice(req.user.id, req.body.token)
    return success(res, { message: 'Device removed' })
  } catch (err) {
    next(err)
  }
})

export default router
