import { LoginForm } from "./login-form";

export const metadata = { title: "Log in · batch0" };

export default function LoginPage() {
  // No searchParams prop and no useSearchParams anywhere in this tree, so the
  // page prerenders with the complete form in the static HTML (asserted by
  // scripts/verify-static.mjs). ?next/?error are read from window.location
  // inside LoginForm's effects/handlers, which never run during prerender.
  // The signed-in bounce away from /login lives in middleware.
  // The auth shell has no <main>, so the page's own (classless) root becomes
  // the skip-link target: <div> → <main>, same box, plus tabIndex={-1} so the
  // element is focusable and screen readers move the cursor to it.
  return (
    <main id="main-content" tabIndex={-1}>
      <h1 className="text-2xl font-bold tracking-tight text-white">Welcome back</h1>
      <p className="mt-1 text-sm text-white/50">
        Log in to your batch0 account.
      </p>
      <LoginForm />
    </main>
  );
}
