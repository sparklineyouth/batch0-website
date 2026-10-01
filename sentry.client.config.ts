import * as Sentry from "@sentry/nextjs";
import { redactSecretUrls } from "@/lib/payment-privacy";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

const isPaymentPage = () => typeof window !== "undefined" && /\/pay(?:\/|$)/.test(window.location.pathname);

// On /support/t/<token> and /demo-day/ticket/<token> the URL is the credential,
// so every event and breadcrumb is sent with the token rewritten to [token]
// (see redactSecretUrls) instead of being dropped like the payment pages'.
if (dsn && !isPaymentPage()) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    beforeSend: (event) => isPaymentPage() ? null : redactSecretUrls(event),
    beforeSendTransaction: (event) => isPaymentPage() ? null : redactSecretUrls(event),
    beforeBreadcrumb: (breadcrumb) => isPaymentPage() ? null : redactSecretUrls(breadcrumb),
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    enabled: process.env.NODE_ENV === "production",
  });
}
