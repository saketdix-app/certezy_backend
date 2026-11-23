// src/utils/reauth.js
// "Confirm with your password" for sensitive actions (no other imports, so any
// service can use it without loading queues or mailers).

import bcrypt from 'bcryptjs'
import { pool } from '../config/db.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

export const reauthenticate = async (actor, password) => {
  const [[fresh]] = await pool.query('SELECT password FROM users WHERE id = ? LIMIT 1', [actor.id])
  if (!fresh?.password) {
    throw fail(400, 'Set a password on your account (Profile → Password) before making this change')
  }
  if (!password || !(await bcrypt.compare(String(password), fresh.password))) {
    throw fail(401, 'Your password is incorrect')
  }
}
