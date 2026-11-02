// src/modules/auth/auth.controller.js

import * as service from './auth.service.js'
import { softDeleteUser, restoreUser, RECOVERY_DAYS } from './userDeletion.js'
import { requestPasswordReset, checkResetToken, resetPassword } from './passwordReset.js'
import { success } from '../../utils/response.js'

import env from '../../config/env.js'

const cookieOptions = {
  httpOnly: true,
  secure: env.cookie.secure,
  sameSite: env.cookie.sameSite,
  ...(env.cookie.domain && { domain: env.cookie.domain }),
}

const setCookies = (res, { accessToken, refreshToken }) => {
  res.cookie('accessToken', accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60 * 1000, // 15 min
  })
  res.cookie('refreshToken', refreshToken, {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  })
}

const clearCookies = (res) => {
  res.clearCookie('accessToken', cookieOptions)
  res.clearCookie('refreshToken', cookieOptions)
}

const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body
    const user = await service.register({ name, email, password })
    return success(res, { statusCode: 201, message: 'Registration successful', data: { user } })
  } catch (err) {
    next(err)
  }
}

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body
    const result = await service.login({ email, password })
    setCookies(res, result)
    return success(res, {
      message: 'Login successful',
      data: { user: result.user, isFirstLogin: result.isFirstLogin, accessToken: result.accessToken },
    })
  } catch (err) {
    next(err)
  }
}

const refresh = async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.refreshToken
    const tokens = await service.refresh(refreshToken)
    setCookies(res, tokens)
    return success(res, {
      message: 'Token refreshed',
      data: { accessToken: tokens.accessToken },
    })
  } catch (err) {
    next(err)
  }
}

const logout = async (req, res, next) => {
  try {
    const refreshToken = req.cookies?.refreshToken
    await service.logout(refreshToken)
    clearCookies(res)
    return success(res, { message: 'Logged out successfully' })
  } catch (err) {
    next(err)
  }
}

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    await service.changePassword({ userId: req.user.id, currentPassword, newPassword })
    clearCookies(res)
    return success(res, { message: 'Password changed successfully. Please sign in again.' })
  } catch (err) {
    next(err)
  }
}

const updateProfile = async (req, res, next) => {
  try {
    const { name, mobile, gender, avatar } = req.body
    const result = await service.updateProfile(req.user.id, { name, mobile, gender, avatar })
    return success(res, { message: 'Profile updated successfully', data: result })
  } catch (err) {
    next(err)
  }
}

// Google & GitHub share the same post-auth flow.
// New and existing OAuth users are both signed in directly — previously new
// users were redirected to /login without a session, which looked like a
// forced login loop.
const oauthCallback = async (req, res, next) => {
  try {
    const result = await service.oauthLogin(req.user)
    setCookies(res, result)
    return res.redirect(`${env.frontendUrl}/oauth/callback`)
  } catch (err) {
    if (err.statusCode === 403) return res.redirect(`${env.frontendUrl}/login?error=account_deleted`)
    next(err)
  }
}

const oauthFailure = (req, res) => {
  return res.redirect(`${env.frontendUrl}/login?error=oauth_failed`)
}

const googleCallback = oauthCallback
const githubCallback = oauthCallback

const me = async (req, res, next) => {
  try {
    return success(res, { message: 'User fetched', data: { user: req.user } })
  } catch (err) {
    next(err)
  }
}

// ── GET /auth/users ────────────────────────────────────────────────────────
const getAllUsers = async (req, res, next) => {
  try {
    const { page, limit, role, search, deleted, status } = req.query
    const result = await service.getAllUsers({
      page,
      limit,
      role,
      search,
      status, // 'active' | 'blocked'
      deleted: deleted === '1' || deleted === 'true',
    })
    return success(res, {
      message: 'Users fetched',
      data: result.users,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

const getUserById = async (req, res, next) => {
  try {
    const user = await service.getById(req.params.id)
    return success(res, { message: 'User fetched', data: { user } })
  } catch (err) {
    next(err)
  }
}

// ── PUT /auth/users/:id/status ─────────────────────────────────────────────
// ── DELETE /auth/users/:id — delete (recoverable for 30 days) ─────────────
const deleteUser = async (req, res, next) => {
  try {
    const data = await softDeleteUser(req.params.id, req.user.id)
    return success(res, { message: `${data.name} deleted — can be restored for ${RECOVERY_DAYS} days`, data })
  } catch (err) {
    next(err)
  }
}

// ── POST /auth/users/:id/restore — undo a delete ──────────────────────────
const restoreDeletedUser = async (req, res, next) => {
  try {
    const data = await restoreUser(req.params.id)
    return success(res, { message: `${data.name} restored`, data })
  } catch (err) {
    next(err)
  }
}

const updateUserStatus = async (req, res, next) => {
  try {
    const user = await service.updateUserStatus(req.params.id, req.body.is_active)
    return success(res, { message: 'User status updated', data: { user } })
  } catch (err) {
    next(err)
  }
}

// ── POST /auth/forgot-password — email a reset link ───────────────────────
// Same answer whether or not the email has an account.
const forgotPassword = async (req, res, next) => {
  try {
    await requestPasswordReset(req.body.email)
    return success(res, {
      message:
        'If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.',
    })
  } catch (err) {
    next(err)
  }
}

// ── GET /auth/reset-password/:token — is the link still valid? ────────────
const checkResetLink = async (req, res, next) => {
  try {
    const valid = await checkResetToken(req.params.token)
    return success(res, { message: valid ? 'Link valid' : 'Link invalid', data: { valid } })
  } catch (err) {
    next(err)
  }
}

// ── POST /auth/reset-password — set the new password ──────────────────────
const resetPasswordWithToken = async (req, res, next) => {
  try {
    await resetPassword(req.body.token, req.body.password)
    return success(res, { message: 'Password changed. Sign in with your new password.' })
  } catch (err) {
    next(err)
  }
}

export {
  forgotPassword,
  checkResetLink,
  resetPasswordWithToken,
  register,
  login,
  refresh,
  logout,
  changePassword,
  updateProfile,
  googleCallback,
  githubCallback,
  oauthFailure,
  me,
  getAllUsers,
  getUserById,
  updateUserStatus,
  deleteUser,
  restoreDeletedUser,
}
