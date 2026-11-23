// src/utils/access.js
// Who may use which admin feature. Super Admins and Admins can do everything;
// Sub-Admins only what is ticked in Team → Permissions (req.user.permissions,
// loaded by the auth middleware).

const ADMINS = ['super_admin', 'admin']

export const isAdmin = (actor) => ADMINS.includes(actor?.role)

/** Admin, or a Sub-Admin with this permission. */
export const can = (actor, key) => isAdmin(actor) || (actor?.role === 'sub_admin' && Boolean(actor?.permissions?.[key]))

/** Works every lead like an Admin: Admins, and Sub-Admins with CRM access. */
export const isCrmManager = (actor) => can(actor, 'can_access_crm')

/** Assigns / transfers leads and runs distribution. */
export const canAssignLeads = (actor) => isAdmin(actor) || (isCrmManager(actor) && can(actor, 'can_assign_leads'))

/** Route guard: Admins, or Sub-Admins with `key`. */
export const allow = (key) => (req, res, next) => {
  if (!req.user) return next(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
  if (can(req.user, key)) return next()
  return next(Object.assign(new Error('Access denied — ask an Admin for this permission'), { statusCode: 403 }))
}

/** Route guard for the CRM: these roles, or a Sub-Admin with CRM access. */
export const crmRoles = (...roles) => (req, res, next) => {
  const r = req.user?.role
  if (!r) return next(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
  if (roles.includes(r) || (r === 'super_admin' && roles.includes('admin')) || isCrmManager(req.user)) return next()
  return next(Object.assign(new Error('Access denied — insufficient permissions'), { statusCode: 403 }))
}
