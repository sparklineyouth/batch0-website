# Next.js 15 security upgrade

Prepared September 14, 2026. This patch moves Next.js 14.2.15 to 15.5.25, the selected patched 15.x release, with React/React DOM 19.3.0 and matching React types. `@next/third-parties` stays on the same Next minor line.

## Why React changes too

The application uses App Router. Next's migration guide requires React 19 for that path; the advertised React 18 compatibility applies to Pages Router. The dependency peer range alone is not enough to choose the app runtime. See the [Next.js 15 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-15) and [React compatibility explanation](https://nextjs.org/blog/next-15).

## Behavior preserved

- Route `params`, page `searchParams`, `headers()`, and `cookies()` are awaited. This includes social image metadata routes missed by the automated codemod.
- The authenticated Supabase server client now awaits request cookies. Callers await the client; browser clients remain synchronous. No unsafe synchronous compatibility casts remain.
- User-specific Supabase queries retain `cache: "no-store"`. Public marketing/blog configuration keeps the existing tagged cache and explicit revalidation. Existing static-render verification must continue to pass.
- `outputFileTracingIncludes` moves from `experimental` to the supported top-level Next 15 option. Social-card font files remain in deployed bundles, including the new starter-kit social card.
- Compatible dependency updates refresh existing packages with reported advisories. No service, application schema, admission decision, tuition amount, or user content changes are part of this patch.

## PostCSS override

Next 15.5.25 pins an older PostCSS version affected by current advisories. A narrow `overrides.next.postcss = "8.5.28"` uses the patched 8.x release while retaining the supported Next 15 release. The rest of the application's PostCSS stack also resolves to 8.5.28. This must pass the real Tailwind/Next production build; a clean dependency audit alone does not prove runtime compatibility.

Do not remove the override until the chosen Next version's dependency is patched. The audit recommendation to move directly to Next 16 is not necessary solely to fix this nested dependency. The lockfile records the resolved package and integrity, so use `npm ci` for deployment.

## Verification

Run from the repository:

```sh
npm ci
npm audit
npm test
npm run build
npm start -- --port 3102
```

In a second terminal:

```sh
node scripts/framework-smoke.mts http://localhost:3102
```

The smoke test makes only local GET requests. It checks public marketing/auth pages, unauthorized course/admin access (including a forged middleware-internal header), social-image rendering, the host-dependent manifest, and robots. It never signs in, sends messages, calls payment writes, or changes student records.

The security patch needs a final integrated build after concurrent curriculum and starter-kit changes are merged. When resolving those changes, preserve `await createClient()` in course pages, promised/awaited lesson params, the new lesson renderer and sanitizer dependency, and the root TypeScript exclusion for the independent MCP package.

Verified on the isolated upgrade branch: a fresh `npm ci` succeeds; `npm audit` reports zero known vulnerabilities; all 213 baseline tests pass; TypeScript passes; the production build generates 377 static pages and the static guard confirms 137 blog articles plus 10 required marketing/auth routes. The localhost production smoke passes all public, authorization, social image, manifest, and robots checks. Concurrent launch changes are deliberately not part of those baseline counts.

Deployment should use a currently supported Node runtime. These local checks ran with Node 26.7.0; the CI/deployment Node version remains a separate environment verification.
