import { SignupCard } from "./signup-form";
import { getPublicSiteConfig } from "@/lib/site-config";

export const metadata = {
  title: "Create Your Account · batch0",
  description:
    "Create your free batch0 account. Applying to a cohort is optional and free; tuition is charged only if you're accepted.",
};

export default async function SignupPage() {
  // Cached public read (tag-busted on admin edits, ≤300s stale): the price
  // here is one sentence of marketing copy, not a gate, and the no-store
  // getSiteConfig() variant would force this page dynamic.
  const { derived } = await getPublicSiteConfig();
  // SignupCard reads ?next from window.location in effects/handlers (no
  // useSearchParams, no Suspense), so the page prerenders with the whole
  // card — heading, form, links — in the static HTML (asserted by
  // scripts/verify-static.mjs). The signed-in bounce away from /signup
  // lives in middleware.
  // The auth shell has no <main>, and SignupCard's own root lives in a client
  // component this page doesn't own — so the target goes on a bare, unstyled
  // <main> here. No classes, so the box model is unchanged. tabIndex={-1}
  // makes it focusable so screen readers move the cursor to it.
  return (
    <main id="main-content" tabIndex={-1}>
      <SignupCard priceLabel={derived.priceLabel} />
    </main>
  );
}
