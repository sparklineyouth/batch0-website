import * as Sentry from "@sentry/nextjs";
import { redactSecretUrls } from "@/lib/payment-privacy";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    // Request URLs, transaction names and spans for /support/t/<token> and
    // /demo-day/ticket/<token> can carry the token; see redactSecretUrls.
    beforeSend: (event) => redactSecretUrls(event),
    beforeSendTransaction: (event) => redactSecretUrls(event),
    beforeBreadcrumb: (breadcrumb) => redactSecretUrls(breadcrumb),
    enabled: process.env.NODE_ENV === "production",
  });
}
