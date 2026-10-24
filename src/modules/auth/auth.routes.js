// src/modules/auth/auth.routes.js

import { Router } from 'express'
import passport from '../../config/passport.js'
import * as controller from './auth.controller.js'
import authenticate from '../../middleware/auth.js'
import { validate, schemas } from '../../middleware/validate.js'
import { loginLimiter, registerLimiter } from '../../middleware/rateLimit.js'
import permission from '../../middleware/permission.js'
import role from '../../middleware/role.js'

const router = Router()

// ─── LOCAL AUTH ──────────────────────────────────────────────
router.post('/register', registerLimiter, validate(schemas.register), controller.register)
router.post('/login', loginLimiter, validate(schemas.login), controller.login)
router.post('/refresh', controller.refresh)
router.post('/logout', controller.logout)

router.post('/change-password', authenticate, validate(schemas.changePassword), controller.changePassword)
router.put('/profile', authenticate, controller.updateProfile)
router.get('/me', authenticate, controller.me)

// ─── GOOGLE OAuth ────────────────────────────────────────────
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }))

router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/api/v1/auth/oauth/failure' }),
  controller.googleCallback
)

// ─── GITHUB OAuth ────────────────────────────────────────────
router.get('/github', passport.authenticate('github', { scope: ['user:email'], session: false }))

router.get(
  '/github/callback',
  passport.authenticate('github', { session: false, failureRedirect: '/api/v1/auth/oauth/failure' }),
  controller.githubCallback
)

// ─── OAUTH FAILURE ───────────────────────────────────────────
router.get('/oauth/failure', controller.oauthFailure)

// ─── ADMIN ────────────────────────────────────────────────────
router.get(
  '/users/all',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_students'),
  controller.getAllUsers
)
router.get(
  '/users/:id',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_students'),
  controller.getUserById
)
router.put('/users/:id/status', authenticate, role('admin'), controller.updateUserStatus)
export default router
