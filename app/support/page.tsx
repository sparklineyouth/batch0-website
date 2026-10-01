import Link from "next/link";
import { redirect } from "next/navigation";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { getProfile } from "@/lib/auth";
import { getPublicSiteConfig } from "@/lib/site-config";
import { JsonLd, breadcrumbJsonLd, webPageJsonLd } from "@/lib/schema";
import { NewTicketForm } from "@/components/support/new-ticket-form";
import { toCategory } from "@/lib/support-access";

const description =
  "Open a support request with batch0 — refunds, billing, account access, privacy requests, and anything else. Every request gets a reference and a reply from a person.";

export const metadata = {
  title: "Support · batch0",
  description,
  alternates: { canonical: "/support" },
};

/**
 * /support — where every policy page and the footer point.
 *
 * Dynamic on purpose, and therefore deliberately NOT added to MUST_BE_STATIC
 * in scripts/verify-static.mjs: the page reads the session to decide between
 * the form and a sign-in prompt, and pre-fills the reply-to address from the
 * account. The three legal pages that link here are all in MUST_BE_STATIC and
 * stay that way — they link with a plain <a href="/support">, never a
 * component out of lib/support.ts, because pulling createAdminClient into a
 * legal page's module graph is exactly the silent de-prerendering the footer's
 * own comment records having caused once already.
 *
 * Signed out, this does not redirect straight to /login. A person who followed
 * "request a refund" out of the policy needs to be told that filing needs an
 * account and that email is an equally valid channel — bouncing them to a
 * login form answers neither question, and for a refund requester the clock is
 * running while they work it out.
 */
export const dynamic = "force-dynamic";

export default async function SupportPage(props: {
  searchParams: Promise<{ topic?: string }>;
}) {
  const [searchParams, profile, config] = await Promise.all([
    props.searchParams,
    getProfile(),
    getPublicSiteConfig(),
  ]);
  const contactEmail = config.settings.contactEmail;
  const topic = toCategory(searchParams.topic);

  // A signed-in account with no email can't be replied to, and the form's
  // action refuses it. Send them to fix it rather than letting them type a
  // request into a dead end.
  if (profile && !profile.email) redirect("/dashboard/settings");

  return (
    <div className="min-h-screen bg-paper">
      <Navbar />
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-2xl px-6 pb-20 pt-16"
      >
        <h1 className="text-4xl font-bold tracking-tight text-ink">Support</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
          Refunds, billing, account access, privacy requests — this is the way
          in. Every request gets a reference, a timestamp, and a reply from a
          person. Nothing here is answered by a bot.
        </p>

        {profile ? (
          <div className="mt-8">
            <NewTicketForm initial={topic} accountEmail={profile.email} />
          </div>
        ) : (
          <div className="mt-8 rounded-xl border border-line bg-wash p-6">
            <h2 className="text-lg font-semibold text-ink">
              Sign in to open a request
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Requests are tied to an account so we can see your payments and
              your application while we answer, and so the thread stays private
              to you. Signing in takes a moment and gets you a faster answer.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link
                href={`/login?next=${encodeURIComponent(
                  `/support?topic=${topic}`,
                )}`}
                prefetch={false}
                className="inline-flex h-10 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md bg-phosphor px-4 text-sm font-semibold leading-none text-on-phosphor shadow-cta hover:bg-phosphor-200 active:scale-[0.98]"
              >
                Log in
              </Link>
              <Link
                href="/signup"
                prefetch={false}
                className="inline-flex h-10 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md border border-line bg-paper px-4 text-sm font-semibold leading-none text-ink hover:border-ink/30 hover:bg-wash active:scale-[0.98]"
              >
                Create an account
              </Link>
            </div>
            {/* The honest alternative, stated at the same weight as the login
                button rather than buried. Someone who paid for a student —
                usually a parent — may have no account at all, and the refund
                policy names email as an equally valid channel precisely so
                this page is never the only door. */}
            <p className="mt-5 border-t border-line pt-4 text-sm text-ink-soft">
              No account, or can&rsquo;t get into yours? Email{" "}
              <a href={`mailto:${contactEmail}`} className="link-ink">
                {contactEmail}
              </a>
              . It reaches the same people and counts the same under our{" "}
              <Link href="/refund-policy" className="link-ink">
                refund policy
              </Link>
              .
            </p>
          </div>
        )}

        <div className="mt-10 border-t border-line pt-6">
          <h2 className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-faint">
            Before you write
          </h2>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            <li>
              <strong className="text-ink">Refunds</strong> are covered by our{" "}
              <Link href="/refund-policy" className="link-ink">
                refund policy
              </Link>{" "}
              — there&rsquo;s a 48-hour window on tuition, and a request filed
              here stops the clock the moment we record it.
            </li>
            <li>
              <strong className="text-ink">Your data</strong> — what we hold and
              how to get a copy or have it deleted — is in our{" "}
              <Link href="/privacy" className="link-ink">
                privacy policy
              </Link>
              .
            </li>
          </ul>
        </div>

        <JsonLd
          data={webPageJsonLd({
            path: "/support",
            name: "Support",
            description,
          })}
        />
        <JsonLd data={breadcrumbJsonLd([{ name: "Support", path: "/support" }])} />
      </main>
      <Footer config={config} />
    </div>
  );
}
