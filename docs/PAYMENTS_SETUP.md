# Payments setup — Razorpay (INR) and PayPal (USD)

Course prices are stored in USD. **PayPal** charges USD. **Razorpay** charges INR,
converted from USD at the live rate (frankfurter.app, fallback 84.5).

## 1. Backend `.env` (on the server)

```env
FRONTEND_URL=https://certezy.com          # PayPal return page = FRONTEND_URL/payment/paypal/return

# Razorpay — Dashboard → Account & Settings → API Keys
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxxx    # rzp_test_… for test mode
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=choose-a-long-random-string   # same value as in the webhook below

# PayPal — developer.paypal.com → Apps & Credentials → (Live) your REST app
PAYPAL_CLIENT_ID=xxxxxxxx
PAYPAL_CLIENT_SECRET=xxxxxxxx
PAYPAL_MODE=live                            # must match the keys: live keys → live, sandbox keys → sandbox
```

Restart the backend after changing `.env` (e.g. `pm2 restart all`).

The frontend needs **no** payment keys: the Razorpay key comes from the API with each
order, and the PayPal approval link comes from PayPal itself (`VITE_PAYPAL_MODE` is only
a fallback).

## 2. Razorpay dashboard

1. **Live mode**: the account must be activated (KYC done) before `rzp_live_` keys accept payments.
2. **Webhook** — Account & Settings → Webhooks → *Add new webhook*
   - URL: `https://certezy.com/api/v1/payments/razorpay/webhook`
   - Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`
   - Active event: **payment.captured**

   The webhook records the payment even if the student closes the page right after paying.
3. Payment methods (UPI, cards, net banking) are switched on under *Payment Methods*.
4. International cards are off by default; INR prices work for Indian cards / UPI either way.

## 3. PayPal

1. Use a **PayPal Business** account (verified, able to receive USD).
2. developer.paypal.com → *Apps & Credentials* → switch to **Live** → create (or open) a REST app →
   copy **Client ID** and **Secret** into `.env`, with `PAYPAL_MODE=live`.
3. Nothing else to configure: the API sends PayPal the return and cancel pages
   (`/payment/paypal/return`, `/payment/paypal/cancel`) with every order.

## 4. Check, then test

1. **Admin → Payments → Check gateways.** Both cards should be green and show the mode
   (TEST / LIVE). A red card shows what to fix (e.g. "Client ID / secret rejected by PayPal
   live — check the keys and PAYPAL_MODE").
2. **Test payment** with a small amount, e.g. a $1 discount link for your own email:
   - **Razorpay test mode** (`rzp_test_` keys): card `4111 1111 1111 1111`, any future
     expiry, any CVV; or UPI `success@razorpay`. No money moves.
   - **PayPal sandbox** (`PAYPAL_MODE=sandbox` + sandbox app keys): pay with a *personal*
     sandbox account from developer.paypal.com → *Sandbox accounts*.
   - **Live**: a real $1 payment, then refund it from the gateway dashboard.
3. After paying, the course opens, *My Courses* lists it and an invoice email arrives.

## 5. When a payment fails

The checkout now shows the gateway's own reason, e.g.
"Razorpay could not start the payment: Authentication failed" or
"PayPal could not start the payment: … PAYEE_ACCOUNT_RESTRICTED …".
The server log has the same line:

```bash
pm2 logs --lines 100 | grep -i -E "razorpay|paypal|payment"
```

| Message | Cause | Fix |
|---|---|---|
| Razorpay is not configured on this server | keys missing | set `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`, restart |
| Razorpay … Authentication failed | wrong / mixed keys | copy both keys again from the same mode |
| PayPal is not configured on this server | keys missing | set `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, restart |
| PayPal … invalid_client / rejected | keys and `PAYPAL_MODE` don't match | live keys need `PAYPAL_MODE=live` |
| PayPal … PAYEE_ACCOUNT_RESTRICTED | PayPal account limited | resolve in the PayPal account |
| Please allow popups for PayPal | (old message — now the tab goes to PayPal instead) | — |

## 6. Which currency a visitor gets

Each course has a **"Sell in Indian rupees (₹) to visitors from India"** switch
(Admin → Courses → edit course). It is **off by default**.

| Course switch | Visitor from India | Everyone else |
|---|---|---|
| Off (default) | US$ price, **PayPal** | US$ price, **PayPal** |
| On | ₹ price, **Razorpay** | US$ price, **PayPal** |

The visitor's country comes from their IP (`src/utils/geo.js`, offline GeoLite data
from `geoip-lite`). The server enforces the rule when creating an order (403 for the
wrong gateway), so it can't be changed in the browser. Rupee prices you saved are
kept while the switch is off and come back when you turn it on.

For local development only, `GEO_FORCE_COUNTRY=US` (or `IN`) in `.env` forces a country.

## 7. PayPal only (no Razorpay)

With every course's rupee switch off, only PayPal is used. The backend `.env` needs:

```env
FRONTEND_URL=https://certezy.com
PAYPAL_CLIENT_ID=your-live-client-id
PAYPAL_CLIENT_SECRET=your-live-secret
PAYPAL_MODE=live
```

The `RAZORPAY_*` lines can stay empty or be removed. Admin → Payments → Check gateways
will then show Razorpay as "not configured" — that's expected.
