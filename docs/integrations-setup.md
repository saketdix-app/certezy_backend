# Lead integrations — setup guide (2.0 Phase 7)

New leads from ads and forms arrive in the CRM automatically, go through the
same duplicate checks, and are shared out by Round Robin.

**Where the keys go:** a Super Admin pastes them into **Admin → Integrations**
(each card → *Keys*), confirms with their password, then presses *Test
connection* and switches the source on. Keys are encrypted in the database,
never shown again (only "Saved"), audit-logged by name, and the other Super
Admins get an email. No restart needed (the background worker picks changes
up within a minute).

The `.env` names below still work as a fallback; a key saved in the portal
takes priority, and removing it in the portal falls back to `.env`.
Optional: set `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`) in `.env`
before saving keys. Without it the encryption key is derived from
`JWT_SECRET`, so changing `JWT_SECRET` later means re-entering the keys.

## Website contact form
Already on. Every Contact Us message also becomes a lead (source: Website).

## Meta (Facebook & Instagram lead forms)
You need: a Facebook Page running lead-form ads, and admin access to its Meta
Business account.

**One-time app setup (by hand — Meta doesn't allow this by API):**
1. <https://developers.facebook.com/apps> → **Create app** → type
   **Business** → connect the CERTEZY Business portfolio.
2. **App settings → Basic**: add the privacy policy URL and `certezy.com`
   under App domains. Copy the **App ID** and **App secret**.
3. Add the **Facebook Login for Business** product → Settings → **Valid
   OAuth Redirect URIs**: paste the redirect URL shown on the Meta card
   (`https://certezy.com/admin/integrations/connect/meta`).
4. Switch the app to **Live**. People who click Connect need a role on the
   app (App roles → add them as Administrator/Developer) unless Meta has
   granted the app Advanced Access.

**Then, in Admin → Integrations → Meta (Super Admin):**
5. **Change keys** → paste App ID and App secret → save.
6. **Connect with Facebook** → confirm your password → sign in → tick your
   Page and allow everything asked. CERTEZY then saves a Page token that
   doesn't expire, creates the webhook verify token, subscribes the Page to
   lead events and points the app's webhook at CERTEZY. The card lists each
   step; anything that failed says why.
7. **Test connection**, switch Meta **on**, map each **form ID** (Meta
   Business Suite → Instant forms) to its course.
8. Test: <https://developers.facebook.com/tools/lead-ads-testing> → create a
   test lead → it appears in Recent imports within seconds.

If your business restricts lead access (Business Settings → Integrations →
Leads access), give access to the app.

## LinkedIn Lead Gen Forms
You need: a LinkedIn Campaign Manager ad account with lead-gen campaigns.

**One-time app setup (by hand):**
1. <https://www.linkedin.com/developers/apps> → Create app, verified by the
   CERTEZY Company Page.
2. **Products** tab → request **Lead Sync API** (LinkedIn reviews it; can
   take days). Also request **Advertising API** if offered — it lets
   Connect find your ad account by itself.
3. **Auth** tab → **Authorized redirect URLs** → add the redirect URL shown
   on the LinkedIn card (`https://certezy.com/admin/integrations/connect/linkedin`).
   Copy the **Client ID** and **Client secret**.

**Then, in Admin → Integrations → LinkedIn (Super Admin):**
4. **Change keys** → paste Client ID and Client secret → save.
5. **Connect with LinkedIn** → password → sign in with an account that has
   a role on the ad account → pick the ad account if asked. Without the
   Advertising API, type the **Ad account ID** (Campaign Manager → the
   number in the account URL) under Change keys.
6. Switch LinkedIn on and press **Sync now**; after that it checks every
   10 minutes.

LinkedIn access tokens last about 60 days. If LinkedIn gave a renewal token
(usual for approved Lead Sync apps), CERTEZY renews it automatically in its
last week. Otherwise the Admins get a notification a week before, and a
Super Admin clicks **Connect with LinkedIn** again.

Optional, faster: if LinkedIn enables lead notifications (webhooks) for your
app, set the webhook URL to `https://certezy.com/api/v1/webhooks/linkedin`.

LinkedIn's response format is versioned (`LINKEDIN_API_VERSION`, default
202411). The field mapping follows LinkedIn's documentation; check the first
real leads after connecting and tell the developer if any field is empty.

## WhatsApp (Cloud API) — 2.0 Phase 8
You need: a WhatsApp Business account on Meta's Cloud API with a phone number
(it can't be the number you use in the WhatsApp app at the same time), and
approved message templates for writing to people first.

1. In the same Meta app (or a new Business app), add the **WhatsApp** product
   and connect your WhatsApp Business account and phone number.
2. **Phone number ID** and **WhatsApp Business Account ID** — WhatsApp → API
   Setup → `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`.
3. **Token** — a System User token with `whatsapp_business_messaging` and
   `whatsapp_business_management` → `WHATSAPP_TOKEN`.
4. **Verify token** — any random string → `WHATSAPP_VERIFY_TOKEN`.
   (Webhooks are checked with the app secret: `META_APP_SECRET`, or
   `WHATSAPP_APP_SECRET` if WhatsApp uses a different app.) Restart.
5. **Webhook** — WhatsApp → Configuration → Callback URL
   `https://certezy.com/api/v1/webhooks/whatsapp`, the verify token, then
   subscribe to **messages**.
6. **Templates** — create and get approved (e.g. a follow-up and a payment
   reminder) in WhatsApp Manager. Only approved templates can be sent when
   the person hasn't written in the last 24 hours (WhatsApp's rule).
7. Switch WhatsApp on in Admin → Integrations. Messages from new numbers
   become leads (source WhatsApp); messages from existing leads appear on
   their WhatsApp thread, and the consultant is notified.

## Automations — 2.0 Phase 8
On by default; switch each off in Admin → Integrations → Automations.
- Paid sale → the lead moves to **Application** (if it was earlier).
- Course completed → the lead moves to **Course Done**.
- Checkout started but unpaid after 1 hour → the consultant is told once.
- Follow-up due within 15 minutes → the consultant is reminded once.

## When something goes wrong
- **Admin → Integrations** shows the last error per source and every
  import. Failed imports retry automatically 5 times (over ~15 minutes),
  then wait for **Retry**.
- A person who is already a lead is not duplicated — the new enquiry is added
  to their timeline and their consultant is notified.
- Leads with neither phone nor email are marked failed (nothing to contact).
