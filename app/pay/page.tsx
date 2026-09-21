import type { Metadata } from "next";
import { PayerCheckout } from "./payer-checkout";

export const metadata: Metadata = {
  title: "Secure Enrollment Payment · batch0",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PayPage() {
  return <main id="main-content" tabIndex={-1} className="mx-auto min-h-[80vh] max-w-2xl px-5 py-16 sm:px-6">
    <a href="/" className="font-display text-3xl">batch0</a>
    <PayerCheckout />
  </main>;
}
