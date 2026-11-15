// src/middleware/role.js

const role = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      const err = new Error('Unauthorized')
      err.statusCode = 401
      return next(err)
    }

    // A Super Admin can do everything an Admin can
    const allowed =
      allowedRoles.includes(req.user.role) ||
      (req.user.role === 'super_admin' && allowedRoles.includes('admin'))
    if (!allowed) {
      const err = new Error('Access denied — insufficient permissions')
      err.statusCode = 403
      return next(err)
    }

    next()
  }
}

export default role
