// src/modules/auth/auth.routes.js

import { Router } from 'express'
import passport from '../../config/passport.js'
import * as controller from './auth.controller.js'
import authenticate from '../../middleware/auth.js'
import { validate, schemas } from '../../middleware/validate.js'
import { registerLimiter, passwordResetLimiter } from '../../middleware/rateLimit.js'
import permission from '../../middleware/permission.js'
import role from '../../middleware/role.js'

const router = Router()

// ─── LOCAL AUTH ──────────────────────────────────────────────
router.post('/register', registerLimiter, validate(schemas.register), controller.register)
// No attempt limit on sign-in (removed on request); two-step codes have their own limits (5 tries, spaced re-sends)
router.post('/login', validate(schemas.login), controller.login)
router.post('/login/verify', validate(schemas.loginCode), controller.verifyLogin)
router.post('/login/resend', validate(schemas.loginChallenge), controller.resendLoginCode)
router.post('/refresh', controller.refresh)
router.post('/activity', authenticate, controller.activity)
router.post('/2fa/setup', authenticate, controller.twoFactorSetup)
router.post('/2fa/enable', authenticate, validate(schemas.loginCode), controller.twoFactorEnable)
router.post('/2fa/disable', authenticate, validate(schemas.reauth), controller.twoFactorDisable)
router.post('/logout', controller.logout)

// Forgot password → email link → new password
router.post(
  '/forgot-password',
  passwordResetLimiter,
  validate(schemas.forgotPassword),
  controller.forgotPassword
)
router.get('/reset-password/:token', controller.checkResetLink)
router.post(
  '/reset-password',
  passwordResetLimiter,
  validate(schemas.resetPassword),
  controller.resetPasswordWithToken
)

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
// Delete (recoverable for 30 days) and restore — admins only
router.delete('/users/:id', authenticate, role('admin'), controller.deleteUser)
router.post('/users/:id/restore', authenticate, role('admin'), controller.restoreDeletedUser)
// Erase a deleted user now instead of waiting for the 30 days (cannot be undone)
router.post('/users/:id/erase', authenticate, role('admin'), controller.eraseDeletedUser)
export default router
