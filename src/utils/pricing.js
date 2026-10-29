// src/utils/pricing.js
// One place that decides what a course costs. Every price the API shows or
// charges goes through here — the client never sends an amount.
//
// Course pricing columns:
//   pricing_type   'free' | 'paid'
//   price          what the student pays (USD)
//   original_price optional list price; when > price the course is "discounted"

const round2 = (n) => Math.round(Number(n) * 100) / 100

export const isFreeCourse = (course) => course?.pricing_type === 'free' || Number(course?.price || 0) <= 0

/** Public pricing summary attached to course payloads. */
export const describePricing = (course) => {
  if (isFreeCourse(course)) {
    return { pricing_type: 'free', price: 0, original_price: null, is_discounted: false, discount_pct: 0 }
  }
  const price = round2(course.price)
  const original = course.original_price != null ? round2(course.original_price) : null
  const isDiscounted = original != null && original > price
  return {
    pricing_type: 'paid',
    price,
    original_price: isDiscounted ? original : null,
    is_discounted: isDiscounted,
    discount_pct: isDiscounted ? Math.round(((original - price) / original) * 100) : 0,
  }
}

/** Decorate a course row (or list of rows) with the computed pricing fields. */
export const withPricing = (course) => (course ? { ...course, ...describePricing(course) } : course)
export const withPricingAll = (rows) => rows.map(withPricing)

/**
 * Amount (USD) to charge a user for a course, optionally with a personal
 * discount link. Throws if the link isn't valid for this user + course.
 */
export const resolveChargeAmount = (course, discount = null) => {
  const { price, original_price } = describePricing(course)
  if (!discount) return { amount: price, original_amount: original_price ?? price }
  return { amount: round2(discount.discount_price), original_amount: price }
}
