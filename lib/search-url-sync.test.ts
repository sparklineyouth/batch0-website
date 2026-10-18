import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { askedFor, pageRendered, startQuerySync, type QuerySync } from "./search-url-sync.ts";

// Run with `npm test`. The Resources and Support search boxes navigate as
// people type and read the page's query back; an older search rendering
// after a newer one was sent used to overwrite what was being typed.

/** Drive a box: what it shows after each render, and whether it followed. */
function box(initial: string) {
  let sync: QuerySync = startQuerySync(initial);
  let value = initial;
  return {
    type(text: string) {
      value = text;
    },
    /** The debounce fired: navigate if it changes what the URL holds. */
    pause() {
      if (value.trim() !== sync.shown) sync = askedFor(sync, value.trim());
    },
    render(pageQuery: string) {
      const r = pageRendered(sync, pageQuery);
      sync = r.sync;
      if (r.follow) value = pageQuery;
      return r.follow;
    },
    get value() {
      return value;
    },
    get sync() {
      return sync;
    },
  };
}

test("an older search rendering after a newer one was sent leaves the typing alone", () => {
  const b = box("");
  b.type("pi");
  b.pause();
  b.type("pitch");
  b.pause();
  b.type("pitch de"); // still typing; not sent yet
  assert.equal(b.render("pi"), false, "the late 'pi' render is the box's own echo");
  assert.equal(b.value, "pitch de");
  assert.equal(b.render("pitch"), false);
  assert.equal(b.value, "pitch de");
  assert.deepEqual(b.sync.asked, [], "nothing left in flight");
});

test("renders in order, or skipped in between, are all echoes", () => {
  const b = box("");
  for (const t of ["d", "de", "dec", "deck"]) {
    b.type(t);
    b.pause();
  }
  // React may drop intermediate transitions and render only the newest.
  assert.equal(b.render("deck"), false);
  assert.deepEqual(b.sync, { shown: "deck", asked: [] });
  // A late render of an older one now reads as the URL moving — it can only
  // be, since everything the box asked for has landed.
  assert.equal(b.render("de"), true);
  assert.equal(b.value, "de");
});

test("typing back to a query already in flight: late renders, in ask order, still leave the typing alone", () => {
  const b = box("");
  b.type("pi");
  b.pause();
  b.type("pitch");
  b.pause();
  b.type("pi");
  b.pause();
  assert.deepEqual(b.sync.asked, ["pi", "pitch", "pi"]);
  b.type("pine"); // still typing; not sent yet
  // The first "pi" lands late. Matched with the newer "pi", it emptied the
  // list, so the "pitch" render read as the URL moving and overwrote the box
  // with "pitch", and then the last "pi" with "pi".
  assert.equal(b.render("pi"), false);
  assert.deepEqual(b.sync.asked, ["pitch", "pi"], "only the first 'pi' is accounted for");
  assert.equal(b.render("pitch"), false);
  assert.equal(b.value, "pine");
  assert.equal(b.render("pi"), false);
  assert.equal(b.value, "pine");
  assert.deepEqual(b.sync.asked, []);
});

test("typing back to a query in flight, with only the newest rendering: the leftovers clear on the next ask", () => {
  const b = box("");
  for (const t of ["pi", "pitch", "pi"]) {
    b.type(t);
    b.pause();
  }
  // Next drops the superseded navigations and renders only the last "pi".
  assert.equal(b.render("pi"), false);
  assert.equal(b.value, "pi");
  b.type("pin");
  b.pause();
  assert.equal(b.render("pin"), false);
  assert.deepEqual(b.sync, { shown: "pin", asked: [] }, "the skipped asks are gone once a newer one renders");
  // And the URL moving under the box is followed again.
  assert.equal(b.render(""), true);
  assert.equal(b.value, "");
});

test("Back, or a Clear link, moves the URL under the box: it follows", () => {
  const b = box("deck");
  assert.equal(b.render(""), true);
  assert.equal(b.value, "");
  assert.deepEqual(b.sync, { shown: "", asked: [] });
});

test("Clear clicked while a search is in flight: the URL it didn't ask for wins", () => {
  const b = box("old");
  b.type("pitch");
  b.pause();
  assert.equal(b.render(""), true, "'' was never asked for: the person cleared it");
  assert.equal(b.value, "");
  assert.deepEqual(b.sync.asked, []);
});

test("asking for what the box already shows waits on nothing", () => {
  let sync = startQuerySync("deck");
  sync = askedFor(sync, "deck"); // a shelf picked with the same query
  assert.deepEqual(sync, { shown: "deck", asked: [] });
  // A long burst never grows without bound.
  for (let i = 0; i < 100; i++) sync = askedFor(sync, `q${i}`);
  assert.ok(sync.asked.length <= 20);
  assert.equal(sync.asked.at(-1), "q99");
});

test("both search boxes decide with the shared rule, not a bare comparison", () => {
  for (const file of ["../app/dashboard/resources/resource-search.tsx", "../app/admin/support/support-search.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /pageRendered\(sync\.current, initialQuery\)/, file);
    assert.match(src, /askedFor\(sync\.current, q\)/, file);
    assert.doesNotMatch(src, /if \(initialQuery === shown\.current\) return;/, file);
  }
});
