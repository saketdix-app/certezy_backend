// src/utils/ist.js
// Every time shown to people (emails, notifications, PDFs) is in India time.

export const IST = 'Asia/Kolkata'

/** "26 Nov 2026, 3:45 pm IST" */
export const fmtIst = (d) =>
  `${new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST })} IST`

/** "3:45 pm IST" */
export const fmtIstTime = (d) =>
  `${new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST })} IST`

/** "26/11/2026" (date only, India time) */
export const fmtIstDate = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: IST })

/** Start of the India-time month `back` months before the one `now` is in, as a UTC Date. */
export const istMonthStart = (now = new Date(), back = 0) => {
  const ist = new Date(now.getTime() + 330 * 60e3)
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - back, 1) - 330 * 60e3)
}
