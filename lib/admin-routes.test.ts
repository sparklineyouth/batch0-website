import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_ROUTE_PERMISSIONS,
  isKnownPermission,
  permissionForAdminPath,
} from "./permissions.ts";

// Run with `npm test`.
//
// An /admin path missing from ADMIN_ROUTE_PERMISSIONS falls open to every
// admin-area role (permissionForAdminPath → null → canViewAdminPath → true),
// and pages read through the service-role client, so the route table is the
// only gate. This walks app/admin at test time so a new page can't ship
// unmapped, and a removed page can't leave a stale row behind.

const ADMIN_DIR = fileURLToPath(new URL("../app/admin/", import.meta.url));

/** Every page under app/admin as the URL it serves. Dynamic segments get a sample value; route groups vanish. */
function adminPages(dir = ADMIN_DIR, segments: string[] = []): string[] {
  const pages: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      pages.push(["/admin", ...segments].join("/"));
    } else if (entry.isDirectory() && !entry.name.startsWith("_")) {
      const segment = /^\(.+\)$/.test(entry.name)
        ? []
        : [/^\[.+\]$/.test(entry.name) ? "sample" : entry.name];
      pages.push(...adminPages(join(dir, entry.name), [...segments, ...segment]));
    }
  }
  return pages;
}

const PAGES = adminPages();

test("the walk finds the admin pages", () => {
  assert.ok(PAGES.length > 20, `found only ${PAGES.length} pages`);
  assert.ok(PAGES.includes("/admin"));
  assert.ok(PAGES.includes("/admin/payments"));
  assert.ok(PAGES.includes("/admin/students/sample"));
});

test("every admin page but the overview resolves to a known permission", () => {
  const unmapped: string[] = [];
  for (const path of PAGES) {
    if (path === "/admin") continue;
    const required = permissionForAdminPath(path);
    if (required === null) {
      unmapped.push(path);
      continue;
    }
    for (const key of typeof required === "string" ? [required] : required) {
      assert.ok(isKnownPermission(key), `${path} → unknown permission ${key}`);
    }
  }
  assert.deepEqual(unmapped, [], "add these to ADMIN_ROUTE_PERMISSIONS in lib/permissions.ts");
});

test("the overview is the one open page", () => {
  assert.equal(permissionForAdminPath("/admin"), null);
});

test("every route rule points at a page that exists", () => {
  const stale = ADMIN_ROUTE_PERMISSIONS.map(([prefix]) => prefix).filter(
    (prefix) => !PAGES.some((p) => p === prefix || p.startsWith(prefix + "/")),
  );
  assert.deepEqual(stale, [], "remove these rows from ADMIN_ROUTE_PERMISSIONS");
});
