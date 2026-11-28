// src/modules/payments/revenue.js
// Revenue for the Super Admin dashboard, split in two:
//  • Online revenue — payments made on the website (status 'success').
//  • Offline sales revenue — CRM leads whose ticket size counts as earned
//    (Payment Done or Course Done) and that did NOT pay online, so no sale is
//    counted twice.
// Months are India-time calendar months. Amounts in a currency other than the
// main one (INR) are listed on their own, never converted or added in.

import { pool } from '../../config/db.js'
import { TICKET_EARNED_SQL } from '../crm/leads.service.js'
import { istMonthStart } from '../../utils/ist.js'

export const MAIN_CURRENCY = 'INR'
const IST_MIN = 330
const CHART_MONTHS = 6

const istPeriod = (d) => new Date(d.getTime() + IST_MIN * 60e3).toISOString().slice(0, 7) // "2026-11"
const istMonthLabel = (d) =>
  new Date(d.getTime() + IST_MIN * 60e3).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })

const num = (v) => Number(v ?? 0)
const money = (v) => Math.round(num(v) * 100) / 100

// Each source as rows of (currency, amount, at)
const ONLINE_SRC = `
  SELECT UPPER(COALESCE(p.currency, 'INR')) AS currency, p.amount, p.created_at AS at
  FROM payments p WHERE p.status = 'success'`
const OFFLINE_SRC = `
  SELECT UPPER(COALESCE(t.currency, 'INR')) AS currency, t.amount,
         CASE WHEN t.earned_at >= '9999-01-01' THEN NULL ELSE t.earned_at END AS at -- Payment Done with no date
  FROM (${TICKET_EARNED_SQL}) t
  WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = t.id AND p.status = 'success')`

const summarise = async (src, thisMonth, lastMonth) => {
  const [rows] = await pool.query(
    `SELECT s.currency, COUNT(*) AS n, SUM(s.amount) AS amount,
            SUM(s.at >= ?) AS this_n,
            SUM(CASE WHEN s.at >= ? THEN s.amount ELSE 0 END) AS this_month,
            SUM(CASE WHEN s.at >= ? AND s.at < ? THEN s.amount ELSE 0 END) AS last_month
     FROM (${src}) s GROUP BY s.currency`,
    [thisMonth, thisMonth, lastMonth, thisMonth]
  )
  const main = rows.find((r) => r.currency === MAIN_CURRENCY)
  return {
    total: money(main?.amount),
    this_month: money(main?.this_month),
    last_month: money(main?.last_month),
    count: num(main?.n),
    this_month_count: num(main?.this_n),
    other_currencies: rows
      .filter((r) => r.currency !== MAIN_CURRENCY)
      .map((r) => ({ currency: r.currency, total: money(r.amount), count: num(r.n), this_month: money(r.this_month) })),
  }
}

const byMonth = async (src, from) => {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(s.at + INTERVAL ${IST_MIN} MINUTE, '%Y-%m') AS period, SUM(s.amount) AS amount
     FROM (${src}) s WHERE s.currency = ? AND s.at >= ? GROUP BY period`,
    [MAIN_CURRENCY, from]
  )
  return Object.fromEntries(rows.map((r) => [r.period, money(r.amount)]))
}

/** Online and offline revenue: totals, this month vs last month, and the last 6 months. */
export const revenueBreakdown = async (now = new Date()) => {
  const thisMonth = istMonthStart(now, 0)
  const lastMonth = istMonthStart(now, 1)
  const chartFrom = istMonthStart(now, CHART_MONTHS - 1)
  const [online, offline, onlineMonths, offlineMonths] = await Promise.all([
    summarise(ONLINE_SRC, thisMonth, lastMonth),
    summarise(OFFLINE_SRC, thisMonth, lastMonth),
    byMonth(ONLINE_SRC, chartFrom),
    byMonth(OFFLINE_SRC, chartFrom),
  ])
  // Every month in the window, including months with no sales
  const months = Array.from({ length: CHART_MONTHS }, (_, i) => {
    const start = istMonthStart(now, CHART_MONTHS - 1 - i)
    const period = istPeriod(start)
    const on = onlineMonths[period] ?? 0
    const off = offlineMonths[period] ?? 0
    return { period, month: istMonthLabel(start), online: on, offline: off, total: money(on + off) }
  })
  return {
    currency: MAIN_CURRENCY,
    online,
    offline,
    total: money(online.total + offline.total),
    months,
    // Older screens read these (online payments only)
    total_revenue: online.total,
    total_revenue_usd: online.total,
    total_sales: online.count,
    monthly_revenue: months.map((m) => ({ period: m.period, month: m.month, revenue: m.online })),
  }
}
