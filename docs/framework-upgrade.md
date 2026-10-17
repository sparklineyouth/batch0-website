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

## October 2026 security patch

Prepared October 17, 2026. Next.js 15.5.25 → 15.5.28 (the newest 15.5 backport), `@next/third-parties` with it, React/React DOM 19.3.0 → 19.3.1, nodemailer 9.1.1 → 10.1.2, sharp 0.35.4 → 0.35.5, and in-range refreshes of brace-expansion, fast-uri and source-map-js. `npm audit --omit=dev` goes from 10 findings (4 high, 6 moderate) to 0; the full audit from 17 to 7, all of them Tailwind 3's build-time file watcher and selector parser (below).

### What `npm audit` did not show

The two advisories that matter most here were published on October 14 as Next.js and React repository advisories and were not in npm's database when this patch was made, so a clean audit on 15.5.27 would have been misleading:

- [GHSA-2464-fhr4-w9xw](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw) (critical): remote code execution in the Image Optimization API through SVG handling in sharp's librsvg on glibc Linux. npm lists the same bug only as the sharp advisory GHSA-wq5f-xc86-pv6w. On Vercel, `/_next/image` runs on Vercel's optimizer, not our function, and `dangerouslyAllowSVG` is off (the optimizer answers 400 for `/icon.svg`), so our exposure was low. The patched `next` and sharp close it anyway, including for any self-hosted `next start`.
- [GHSA-p3m5-59mp-jv5r](https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r) (high): CPU denial of service against any App Router app with a Server Action. This applies to us: the app has 75 `"use server"` modules, from sign-up and password reset to the application and the admin forms.
- React [GHSA-xqc2-xf4c-x3h3](https://github.com/facebook/react/security/advisories/GHSA-xqc2-xf4c-x3h3) (critical RCE) and [GHSA-h3gv-c5rc-p453](https://github.com/facebook/react/security/advisories/GHSA-h3gv-c5rc-p453) (high DoS) name `react-server-dom-*`. The App Router runs Next's vendored copy (`next/dist/compiled/react-server-dom-webpack`), not the top-level `react` package, so the `next` bump is the fix. 15.5.28's vendored Flight server carries the typed-array transport change; diff it against 15.5.25 to confirm. `react`/`react-dom` move to 19.3.1 so the top-level packages are on the patched release too.

### Overrides

- `overrides.next.postcss = "8.5.28"` stays (see above). Next 15.5.28 still pins PostCSS 8.4.31.
- `overrides["js-yaml"].argparse = "2.0.1"` is new. gray-matter 4.0.3 (the newest release, from 2021) needs js-yaml 3, which pulls argparse 1 → sprintf-js, and no sprintf-js release fixes GHSA-hp3w-g68c-fv3c. js-yaml's library never loads argparse; only its `js-yaml` CLI does, and that CLI still runs on argparse 2 (it prints deprecation warnings). So the override changes no code that parses blog front matter. `lib/dependency-advisories.test.ts` fails if gray-matter ever starts loading argparse. Remove the override if gray-matter is replaced or moves to js-yaml 4.

### Accepted: Tailwind 3 build tooling

braces (no fixed release exists), micromatch, chokidar, fast-glob, postcss-selector-parser and postcss-nested reach us only through `tailwindcss` 3.4.19, the last 3.x release, which is a devDependency. They run once per `next build` over our own content globs and stylesheets; no request reaches them. The only fix npm offers is Tailwind 4, a rewrite of the config and PostCSS setup, so it gets its own change.

### Holding it in place

`lib/dependency-advisories.test.ts` (part of `npm test`) reads `package-lock.json` and fails if any installed copy of these packages falls back inside a published vulnerable range, if `next`/`@next/third-parties` or `react`/`react-dom` drift apart, or if nodemailer 10 stops giving `lib/email/send.ts` the transport it calls. To re-check advisories:

```sh
npm ci
npm audit --omit=dev    # expect 0
npm audit               # expect only the Tailwind 3 chain above
npm audit signatures    # registry signatures and provenance
```
