"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

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
        </div>
      </body>
    </html>
  );
}
