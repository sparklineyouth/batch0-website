import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTicketAmount,
  normalizeTicketEmail,
  normalizeTicketText,
  formatTicketAmount,
  MIN_TICKET_CENTS,
  MAX_TICKET_CENTS,
} from "./demo-day-ticket-input.ts";

// Run with `npm test`. No framework — Node strips the types natively.

test("parses the ways an admin writes a price", () => {
  assert.equal(parseTicketAmount("25"), 2500);
  assert.equal(parseTicketAmount("25.00"), 2500);
  assert.equal(parseTicketAmount("$25"), 2500);
  assert.equal(parseTicketAmount(" 1,250.5 "), 125050);
  assert.equal(parseTicketAmount("0.50"), 50);
});

test("rounds cents rather than truncating", () => {
  // 19.99 * 100 is 1998.9999… in floating point.
  assert.equal(parseTicketAmount("19.99"), 1999);
});

test("refuses what isn't a price", () => {
  for (const v of ["", "free", "-5", "25.", "25.001", "1e3", "$", "25 dollars"]) {
    assert.equal(parseTicketAmount(v), null, `expected null: ${JSON.stringify(v)}`);
  }
});

test("enforces Stripe's floor and a sanity ceiling", () => {
  assert.equal(parseTicketAmount("0.49"), null);
  assert.equal(parseTicketAmount((MIN_TICKET_CENTS / 100).toFixed(2)), MIN_TICKET_CENTS);
  assert.equal(parseTicketAmount((MAX_TICKET_CENTS / 100).toFixed(2)), MAX_TICKET_CENTS);
  assert.equal(parseTicketAmount(((MAX_TICKET_CENTS + 1) / 100).toFixed(2)), null);
});

test("normalises email case and whitespace", () => {
  assert.equal(normalizeTicketEmail("  Alex@Example.COM "), "alex@example.com");
});

test("rejects non-addresses", () => {
  for (const v of ["", "alex", "alex@", "@example.com", "alex@example", "a b@example.com"]) {
    assert.equal(normalizeTicketEmail(v), null, `expected null: ${JSON.stringify(v)}`);
  }
});

test("trims and caps free text, empty becomes null", () => {
  assert.equal(normalizeTicketText("   ", 10), null);
  assert.equal(normalizeTicketText(undefined, 10), null);
  assert.equal(normalizeTicketText("  hi  ", 10), "hi");
  assert.equal(normalizeTicketText("abcdefghijklmnop", 5), "abcde");
});

test("formats whole dollars without cents and fractional with two", () => {
  assert.equal(formatTicketAmount(2500), "$25");
  assert.equal(formatTicketAmount(1999), "$19.99");
  assert.equal(formatTicketAmount(125050), "$1,250.50");
});
