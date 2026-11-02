// src/utils/pricing.js
// One place that decides what a course costs. Every price the API shows or
// charges goes through here — the client never sends an amount.
//
// Course pricing columns:
//   pricing_type   'free' | 'paid'
//   price          what the student pays (USD)
//   original_price optional list price; when > price the course is "discounted"
//   price_inr / original_price_inr   optional India prices in rupees; when empty
//                  they are converted from USD at the current rate

import { usdToInr } from './fx.js'

const round2 = (n) => Math.round(Number(n) * 100) / 100

export const isFreeCourse = (course) => course?.pricing_type === 'free' || Number(course?.price || 0) <= 0

/** Public pricing summary attached to course payloads. */
export const describePricing = (course) => {
  if (isFreeCourse(course)) {
    return {
      pricing_type: 'free',
      price: 0,
      original_price: null,
      is_discounted: false,
      discount_pct: 0,
      price_inr: 0,
      original_price_inr: null,
      is_discounted_inr: false,
      discount_pct_inr: 0,
      inr_price_set: false,
    }
  }
  const price = round2(course.price)
  const original = course.original_price != null ? round2(course.original_price) : null
  const isDiscounted = original != null && original > price
  // India price: the admin's rupee price, or the USD price converted
  const inrSet = course.price_inr != null && Number(course.price_inr) > 0
  const priceInr = inrSet ? round2(course.price_inr) : usdToInr(price)
  const originalInrRaw = inrSet
    ? course.original_price_inr != null
      ? round2(course.original_price_inr)
      : null
    : isDiscounted
      ? usdToInr(original)
      : null
  const isDiscountedInr = originalInrRaw != null && originalInrRaw > priceInr

  return {
    pricing_type: 'paid',
    price,
    original_price: isDiscounted ? original : null,
    is_discounted: isDiscounted,
    discount_pct: isDiscounted ? Math.round(((original - price) / original) * 100) : 0,
    price_inr: priceInr,
    original_price_inr: isDiscountedInr ? originalInrRaw : null,
    is_discounted_inr: isDiscountedInr,
    discount_pct_inr: isDiscountedInr ? Math.round(((originalInrRaw - priceInr) / originalInrRaw) * 100) : 0,
    inr_price_set: inrSet,
  }
}

/**
 * Rupee amount to charge (Razorpay) — the India price, or with a discount link
 * the same share of it as the link takes off the USD price.
 */
export const resolveChargeAmountInr = (course, discount = null) => {
  const p = describePricing(course)
  if (!discount) return { amount: p.price_inr, original_amount: p.original_price_inr ?? p.price_inr }
  const share = Number(discount.discount_price) / Number(p.price || 1)
  return { amount: Math.max(1, Math.round(p.price_inr * share)), original_amount: p.price_inr }
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
