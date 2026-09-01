/**
 * Post-migration check for the custom-roles system (migration 0048).
 *
 *   npm run verify-roles
 *
 * Read-only apart from one temporary role it creates and deletes, so it is
 * safe to run against production. Exits non-zero on the first failure.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function rest(path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

async function rpc(fn, args) {
  return rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
}

console.log("\napp_roles table\n");

const roles = await rest("app_roles?select=*&order=rank");
check("table exists and is readable", roles.ok, roles.ok ? "" : JSON.stringify(roles.body));
if (!roles.ok) {
  console.error("\nMigration 0048 has not been applied. Stopping.\n");
  process.exit(1);
}

const bySlug = Object.fromEntries(roles.body.map((r) => [r.slug, r]));

for (const slug of ["student", "admin", "mentor", "investor", "intern"]) {
  check(`seeded role "${slug}"`, !!bySlug[slug]);
}

check(
  "admin holds the wildcard",
  bySlug.admin?.permissions?.includes("*"),
  JSON.stringify(bySlug.admin?.permissions),
);
check(
  "student holds student.dashboard",
  bySlug.student?.permissions?.includes("student.dashboard"),
);
check("mentor holds mentor.panel", bySlug.mentor?.permissions?.includes("mentor.panel"));
check(
  "investor holds investor.panel",
  bySlug.investor?.permissions?.includes("investor.panel"),
);
check(
  "intern has admin-area permissions but no wildcard",
  bySlug.intern?.permissions?.length > 0 && !bySlug.intern.permissions.includes("*"),
  JSON.stringify(bySlug.intern?.permissions),
);
check("intern lands on /admin", bySlug.intern?.home_path === "/admin");
check(
  "the four originals are marked system",
  ["student", "admin", "mentor", "investor"].every((s) => bySlug[s]?.is_system),
);
check("intern is deletable (not a system role)", bySlug.intern?.is_system === false);

console.log("\nprofiles.role foreign key\n");

const orphans = await rest(
  `profiles?select=id,role&role=not.in.(${roles.body.map((r) => r.slug).join(",")})`,
);
check(
  "no profile points at a non-existent role",
  orphans.ok && orphans.body.length === 0,
  orphans.ok ? "" : JSON.stringify(orphans.body),
);

const badInsert = await rest("app_roles", {
  method: "POST",
  body: JSON.stringify({ slug: "Bad Slug!", label: "x" }),
});
check(
  "slug format constraint rejects invalid slugs",
  !badInsert.ok,
  `status ${badInsert.status}`,
);

console.log("\npermission helper functions\n");

const admins = await rest("profiles?select=id,email&role=eq.admin&limit=1");
const students = await rest("profiles?select=id,email&role=eq.student&limit=1");
const anAdmin = admins.body?.[0];
const aStudent = students.body?.[0];

if (anAdmin) {
  const r1 = await rpc("has_permission", { uid: anAdmin.id, perm: "settings.manage" });
  check("has_permission(admin, settings.manage) = true", r1.body === true, JSON.stringify(r1.body));
  const r2 = await rpc("is_admin", { uid: anAdmin.id });
  check("is_admin(admin) = true", r2.body === true, JSON.stringify(r2.body));
  const r3 = await rpc("user_permissions", { uid: anAdmin.id });
  check("user_permissions(admin) = ['*']", JSON.stringify(r3.body) === '["*"]', JSON.stringify(r3.body));
} else {
  check("found an admin profile to test against", false);
}

if (aStudent) {
  const r4 = await rpc("has_permission", { uid: aStudent.id, perm: "settings.manage" });
  check("has_permission(student, settings.manage) = false", r4.body === false, JSON.stringify(r4.body));
  const r5 = await rpc("is_admin", { uid: aStudent.id });
  check("is_admin(student) = false", r5.body === false, JSON.stringify(r5.body));
  const r6 = await rpc("is_staff", { uid: aStudent.id });
  check("is_staff(student) = false", r6.body === false, JSON.stringify(r6.body));
} else {
  check("found a student profile to test against", false);
}

console.log("\ncreate → assign → delete round trip\n");

const TMP = "verify-tmp-role";
await rest(`app_roles?slug=eq.${TMP}`, { method: "DELETE" }); // clean any prior run

const created = await rest("app_roles", {
  method: "POST",
  body: JSON.stringify({
    slug: TMP,
    label: "Verify Temp",
    permissions: ["challenges.manage"],
    home_path: "/admin",
    color: "sky",
  }),
});
check("can create a custom role", created.ok, created.ok ? "" : JSON.stringify(created.body));

if (created.ok && aStudent) {
  const assigned = await rest(`profiles?id=eq.${aStudent.id}`, {
    method: "PATCH",
    body: JSON.stringify({ role: TMP }),
  });
  check("can assign a custom role to a profile", assigned.ok, JSON.stringify(assigned.body));

  const perm = await rpc("has_permission", { uid: aStudent.id, perm: "challenges.manage" });
  check("holder gains the role's permission", perm.body === true, JSON.stringify(perm.body));

  const notPerm = await rpc("has_permission", { uid: aStudent.id, perm: "settings.manage" });
  check("holder does NOT gain unticked permissions", notPerm.body === false);

  const stillNotAdmin = await rpc("is_admin", { uid: aStudent.id });
  check("custom role does not satisfy is_admin()", stillNotAdmin.body === false);

  // A role that people still hold must not be deletable — the FK is what
  // forces the reassign step in the admin UI.
  const blocked = await rest(`app_roles?slug=eq.${TMP}`, { method: "DELETE" });
  check(
    "FK blocks deleting a role that people still hold",
    !blocked.ok,
    `status ${blocked.status}`,
  );

  await rest(`profiles?id=eq.${aStudent.id}`, {
    method: "PATCH",
    body: JSON.stringify({ role: "student" }),
  });
  const cleaned = await rest(`app_roles?slug=eq.${TMP}`, { method: "DELETE" });
  check("role deletes once nobody holds it", cleaned.ok, JSON.stringify(cleaned.body));

  const restored = await rest(`profiles?select=role&id=eq.${aStudent.id}`);
  check(
    "test profile restored to student",
    restored.body?.[0]?.role === "student",
    JSON.stringify(restored.body),
  );
}

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
