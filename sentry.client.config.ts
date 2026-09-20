import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

const isPaymentPage = () => typeof window !== "undefined" && /\/pay(?:\/|$)/.test(window.location.pathname);

if (dsn && !isPaymentPage()) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    beforeSend: (event) => isPaymentPage() ? null : event,
    beforeSendTransaction: (event) => isPaymentPage() ? null : event,
    beforeBreadcrumb: (breadcrumb) => isPaymentPage() ? null : breadcrumb,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    enabled: process.env.NODE_ENV === "production",
  });
}
