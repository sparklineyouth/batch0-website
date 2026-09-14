import assert from "node:assert/strict";

// Run against a locally started production build. No accounts are created,
// no forms are submitted, and no email/payment/AI write endpoint is called.
const base = new URL(process.argv[2] ?? "http://localhost:3102");
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
  throw new Error("This development smoke test accepts localhost only.");
}

const publicPages = ["/", "/program", "/blog", "/blog/what-is-an-mvp", "/login", "/signup"];
for (const path of publicPages) {
  const response = await fetch(new URL(path, base), { redirect: "manual" });
  assert.equal(response.status, 200, `${path} must load anonymously`);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.ok((await response.text()).includes("batch0"), `${path} should render the app`);
}

for (const path of ["/admin", "/admin/events", "/dashboard/course", "/dashboard/events"]) {
  for (const spoofMiddleware of [false, true]) {
    const response = await fetch(new URL(path, base), {
      redirect: "manual",
      headers: spoofMiddleware
        ? { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" }
        : undefined,
    });
    assert.ok([303, 307, 308].includes(response.status), `${path} must reject anonymous access (spoof=${spoofMiddleware})`);
    const destination = new URL(response.headers.get("location") ?? "", base);
    assert.ok(["/login", "/signup"].includes(destination.pathname), `${path} should lead to authentication`);
  }
}

for (const path of ["/opengraph-image", "/blog/what-is-an-mvp/opengraph-image"]) {
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, 200, `${path} must render`);
  assert.match(response.headers.get("content-type") ?? "", /image\/png/);
  assert.ok((await response.arrayBuffer()).byteLength > 1000, `${path} should contain a real image`);
}

const manifestResponse = await fetch(new URL("/manifest.webmanifest", base));
assert.equal(manifestResponse.status, 200);
const manifest = await manifestResponse.json() as { start_url?: string };
assert.ok(manifest.start_url?.startsWith("/"), "Async headers must retain the manifest start URL");

const robots = await fetch(new URL("/robots.txt", base));
assert.equal(robots.status, 200);
assert.match(await robots.text(), /Sitemap:/);

console.log("Framework smoke passed: 6 public pages, 8 protected-route checks, 2 social images, manifest, and robots.");
