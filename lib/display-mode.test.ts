import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isInstalledApp, keepInAppWindow } from "./display-mode.ts";

// Run with `npm test`.

const win = (standalone: boolean, iosStandalone?: boolean) => ({
  matchMedia: (q: string) => ({ matches: standalone && q === "(display-mode: standalone)" }),
  navigator: iosStandalone === undefined ? {} : { standalone: iosStandalone },
});

test("installed app: display-mode standalone, or older iOS's navigator.standalone", () => {
  assert.equal(isInstalledApp(win(true)), true);
  assert.equal(isInstalledApp(win(false, true)), true);
  assert.equal(isInstalledApp(win(false, false)), false);
  assert.equal(isInstalledApp(win(false)), false);
  assert.equal(isInstalledApp(undefined), false);
  assert.equal(
    isInstalledApp({
      matchMedia: () => {
        throw new Error("unsupported");
      },
    }),
    false,
  );
});

test("a material click stays in the installed app's window, where its session is", () => {
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(keepInAppWindow(plain, true), true);
  // In a browser the new tab shares the cookie: leave it alone.
  assert.equal(keepInAppWindow(plain, false), false);
  // Asking for something else (a new tab on purpose, a middle click).
  assert.equal(keepInAppWindow({ ...plain, metaKey: true }, true), false);
  assert.equal(keepInAppWindow({ ...plain, button: 1 }, true), false);

  const page = readFileSync(new URL("../app/dashboard/course/[lessonId]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<MaterialLink\s+href=\{m\.href\}/);
  assert.doesNotMatch(page, /target="_blank"/);
  const link = readFileSync(new URL("../app/dashboard/course/[lessonId]/material-link.tsx", import.meta.url), "utf8");
  assert.match(link, /keepInAppWindow\(e, isInstalledApp\(\)\)/);
  assert.match(link, /window\.location\.assign\(href\)/);
});
