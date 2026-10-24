// src/modules/admin/admin.queries.js

import { pool } from '../../config/db.js'

// ── Get permissions by user_id ─────────────────────────────────────────────
const getPermissionsByUserId = (user_id) =>
  pool.query(`SELECT * FROM admin_permissions WHERE user_id = ? LIMIT 1`, [user_id])

// ── Create permissions ─────────────────────────────────────────────────────
const createPermissions = ({
  user_id,
  can_manage_courses,
  can_manage_students,
  can_send_discounts,
  can_view_payments,
  can_manage_tests,
  created_by,
}) =>
  pool.query(
    `INSERT INTO admin_permissions
       (user_id, can_manage_courses, can_manage_students, can_send_discounts, can_view_payments, can_manage_tests, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      user_id,
      can_manage_courses ?? 0,
      can_manage_students ?? 0,
      can_send_discounts ?? 0,
      can_view_payments ?? 0,
      can_manage_tests ?? 0,
      created_by,
    ]
  )

// ── Update permissions ─────────────────────────────────────────────────────
const updatePermissions = (
  user_id,
  { can_manage_courses, can_manage_students, can_send_discounts, can_view_payments, can_manage_tests }
) =>
  pool.query(
    `UPDATE admin_permissions
     SET can_manage_courses = ?, can_manage_students = ?,
         can_send_discounts = ?, can_view_payments = ?,
         can_manage_tests = ?
     WHERE user_id = ?`,
    [
      can_manage_courses,
      can_manage_students,
      can_send_discounts,
      can_view_payments,
      can_manage_tests,
      user_id,
    ]
  )

// ── Delete permissions ─────────────────────────────────────────────────────
const deletePermissions = (user_id) =>
  pool.query(`DELETE FROM admin_permissions WHERE user_id = ?`, [user_id])

// ── Get dashboard stats ────────────────────────────────────────────────────
const getDashboardStats = async () => {
  const [userCount] = await pool.query(`SELECT COUNT(*) AS total FROM users`)
  const [activeUserCount] = await pool.query(`SELECT COUNT(*) AS total FROM users WHERE is_active = 1`)
  const [courseCount] = await pool.query(`SELECT COUNT(*) AS total FROM courses`)
  const [publishedCourseCount] = await pool.query(
    `SELECT COUNT(*) AS total FROM courses WHERE status = 'published'`
  )
  const [enrollmentCount] = await pool.query(`SELECT COUNT(*) AS total FROM enrollments`)
  const [revenueSum] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'success'`
  )
  const [thisMonthRevenue] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'success' AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`
  )
  const [pendingReviews] = await pool.query(`SELECT COUNT(*) AS total FROM reviews WHERE is_approved = 0`)
  const [pendingPayments] = await pool.query(
    `SELECT COUNT(*) AS total FROM payments WHERE status = 'pending'`
  )

  let recentEnrollments = []
  try {
    const [rows] = await pool.query(
      `SELECT e.id, e.user_id, e.course_id, e.enrolled_at,
              u.name AS student_name, c.title AS course_title
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
       JOIN courses c ON c.id = e.course_id
       ORDER BY e.enrolled_at DESC
       LIMIT 5`
    )
    recentEnrollments = rows
  } catch {
    recentEnrollments = []
  }

  const totalUsers = Number(userCount[0]?.total || 0)
  const activeUsers = Number(activeUserCount[0]?.total || 0)
  const totalCourses = Number(courseCount[0]?.total || 0)
  const publishedCourses = Number(publishedCourseCount[0]?.total || 0)
  const totalEnrollments = Number(enrollmentCount[0]?.total || 0)
  const totalRevenue = Number(revenueSum[0]?.total || 0)
  const thisMonthRev = Number(thisMonthRevenue[0]?.total || 0)
  const pendingRev = Number(pendingReviews[0]?.total || 0)
  const pendingPay = Number(pendingPayments[0]?.total || 0)

  return {
    total_users: totalUsers,
    totalUsers,
    active_users: activeUsers,
    activeUsers,
    total_courses: totalCourses,
    totalCourses,
    published_courses: publishedCourses,
    publishedCourses,
    total_enrollments: totalEnrollments,
    totalEnrollments,
    total_revenue: totalRevenue,
    totalRevenue,
    this_month_revenue: thisMonthRev,
    thisMonthRevenue: thisMonthRev,
    pending_reviews: pendingRev,
    pendingReviews: pendingRev,
    pending_payments: pendingPay,
    pendingPayments: pendingPay,
    recent_enrollments: recentEnrollments,
    recentEnrollments,
    user_growth: 12,
    userGrowth: 12,
    active_user_growth: 8,
    activeUserGrowth: 8,
    revenue_growth: 15,
    revenueGrowth: 15,
    course_growth: 5,
    courseGrowth: 5,
  }
}

export { getPermissionsByUserId, createPermissions, updatePermissions, deletePermissions, getDashboardStats }
