# Public offer and parent experience

`/parents` is the shareable program guide: tuition, expected work, facilitator identity, enrollment steps, contact details and the actual live calendar. `?cohort=<uuid>` keeps an accepted student's guide attached to their cohort even after the default offer advances. `/sample-lesson` is a public customer-interview exercise with a clearly fictional worked example and example feedback; it is not a testimonial or student outcome.

`getSiteConfig` selects an eligible active/upcoming cohort using the same admission rules as checkout. A stale active-cohort setting cannot advertise closed enrollment indefinitely. Late entry needs an explicit deadline and catch-up plan. Tuition keeps its cents, winter dates include both years, deadlines use America/New_York, and unavailable enrollment fails closed. The accepted page uses `applicationQuote`, including an active checkout reservation's held price, and disables payment and link generation if tuition cannot be verified.

The parent and program calendars read only public event fields: ID, title, type, start and end. They exclude staff-only events and events outside the cohort dates; private session URLs, descriptions and student records never enter the public response. Empty/unpublished schedules explicitly direct families to ask before paying. No Winter timetable is inferred from Fall. Times display Eastern daylight/standard offsets correctly.

Demo Day copy describes the configured staff-hosted presentation of submitted recordings or narrated decks, with moderated written questions. Public pages do not promise a student's live microphone slot, outside investors, funding or an outcome guarantee. Terms eligibility now matches the international application flow. The refund policy page and the existing terms Payments/refund language remain unchanged.

`/pay` is public, excluded from robots and the sitemap, and sets no-referrer metadata. Its fragment token/session ID is captured into memory and immediately removed from the address. Analytics and client error telemetry are excluded there. Only a verified API response can show confirmed payment; a forged `?status=confirmed` cannot. See `parent-checkout.md` for the payment API, reservation and fulfillment design.

Funnel events record application start, application submission (existing success event), signup completion and student checkout opening without names, emails, answers or payment tokens. Optional application links are grouped in a disclosure; server-required fields remain required. No submissions or payments were made during UI verification.

## Verification

- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/payment-privacy.test.ts lib/offer-format.test.ts`: exact cents, Eastern deadline, schedule filtering/order, DST, fragment removal and spoofed payment confirmation.
- TypeScript project check and whitespace check.
- Native Chrome via CUA: desktop parent guide, public sample lesson, forged payment query, and payment/parent pages at 400px. The restored Fall guide showed all 18 sessions, the September 21 catch-up orientation, the September 22 Eastern deadline and the EDT-to-EST transition. No authenticated production application or payment was submitted. Before the cohort migration, the local site correctly showed the next eligible Winter offer and unpublished timetable.

Before deployment, run the full build and repository tests after the shared migrations are ready. The integration owner must verify the post-migration Fall timetable and admission cutoff in the deployed environment.
