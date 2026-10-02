"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * "Keeps happening?" here is an email, not a link to the /support form like
 * every other error screen's (components/ui/error-screen.tsx). This boundary
 * only renders when the ROOT layout failed (or the root error screen did), and
 * /support renders inside that same layout — so the form is the door most
 * likely to be broken too. A mailto needs nothing from the site.
 *
 * The digest rides in the subject: it finds the exact failure in Sentry, URL
 * included, so the page path doesn't have to — and leaving it out means this
 * screen never reads the address bar of what may be a secret token URL.
 * Hardcoded, as on the receipts page: the configurable contact address is a
 * server read, which a client-only last-resort screen can't make.
 */
const CONTACT_EMAIL = "hello@batch0.org";

function reportMailto(digest: string | undefined): string {
  const subject =
    digest && /^[A-Za-z0-9_-]{1,64}$/.test(digest)
      ? `Site error (reference ${digest})`
      : "Site error";
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          backgroundColor: "#000",
          color: "#fff",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <p
            style={{
              fontSize: "11px",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.22em",
              color: "#FFD300",
              margin: 0,
            }}
          >
            Something broke
          </p>
          <h1
            style={{
              marginTop: "12px",
              fontSize: "30px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              lineHeight: 1.15,
            }}
          >
            We hit a snag.
          </h1>
          <p
            style={{
              marginTop: "16px",
              fontSize: "15px",
              lineHeight: 1.5,
              color: "rgba(255,255,255,0.7)",
            }}
          >
            The page failed to load. The error has been reported — try again,
            or head back home.
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: "16px",
                wordBreak: "break-all",
                border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(255,255,255,0.03)",
                padding: "8px 12px",
                fontSize: "11px",
                borderRadius: "6px",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              Reference:{" "}
              <span style={{ color: "rgba(255,255,255,0.8)" }}>
                {error.digest}
              </span>
            </p>
          )}
          <div
            style={{
              marginTop: "28px",
              display: "flex",
              gap: "12px",
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={reset}
              style={{
                background: "#FFD300",
                color: "#000",
                fontWeight: 600,
                fontSize: "14px",
                padding: "10px 16px",
                borderRadius: "6px",
                border: "none",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                border: "1px solid rgba(255,255,255,0.15)",
                color: "rgba(255,255,255,0.8)",
                fontWeight: 500,
                fontSize: "14px",
                padding: "10px 16px",
                borderRadius: "6px",
                textDecoration: "none",
              }}
            >
              Go home
            </a>
          </div>
          <p
            style={{
              marginTop: "20px",
              fontSize: "12px",
              color: "rgba(255,255,255,0.6)",
            }}
          >
            Keeps happening? Email{" "}
            <a
              href={reportMailto(error.digest)}
              style={{
                color: "rgba(255,255,255,0.8)",
                textDecoration: "underline",
                textUnderlineOffset: "2px",
              }}
            >
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
      </body>
    </html>
  );
}
