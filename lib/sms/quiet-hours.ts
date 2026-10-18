// ---------------------------------------------------------------------------
// Quiet hours — never text someone at 6am in their own timezone.
//
// This is the cheapest insurance in the whole SMS feature. Quiet-hours claims
// are currently the highest-volume TCPA theory, the rule is objective (there is
// no "we meant well" defence to a 7am text), and the fix is arithmetic.
//
// The hard part is not the window, it is knowing whose window applies. We do not
// ask for a timezone and never will — one more required field on a form that
// already loses people. So the timezone is inferred from the area code, which is
// accurate for the large majority of US numbers and wrong in a bounded, known
// way for the rest. What matters is what happens when we DON'T know: see
// UNKNOWN_ZONE_SAFE_ZONES below, because defaulting to Eastern would send a 9am
// Eastern message at 6am to a California number, which is the exact violation
// this file exists to prevent.
// ---------------------------------------------------------------------------

/**
 * NANP area code → IANA timezone.
 *
 * Not exhaustive, and deliberately not apologetic about it: an unmapped code
 * falls through to a MORE restrictive window, not a guess. Codes that straddle
 * a boundary (850 in the Florida panhandle, 906 in Michigan's Upper Peninsula,
 * 308 in western Nebraska) are assigned their majority zone; the residual error
 * is at most one hour against a window already an hour tighter than federal law
 * requires on each side.
 *
 * Zones without DST are named explicitly (Phoenix, Regina, Honolulu, Puerto
 * Rico) rather than folded into their neighbours, because Intl handles the
 * offset correctly only if it is given the real zone.
 */
const AREA_CODE_ZONES: Record<string, string> = {};

function assignZone(zone: string, codes: string) {
  for (const code of codes.split(/\s+/).filter(Boolean)) {
    AREA_CODE_ZONES[code] = zone;
  }
}

// Eastern — US
assignZone(
  "America/New_York",
  `202 203 475 860 959 302 305 321 352 386 407 448 561 656 689 727 728 754 772 786 813 863 904 941 954
   229 404 470 478 678 706 762 770 912 943 260 317 463 574 765 812 930 606 859 207 227 240 301 410 443 667
   339 351 413 508 617 774 781 857 978 231 248 269 313 517 586 616 679 734 810 947 989 603
   201 551 609 640 732 848 856 862 908 973 212 315 332 347 363 516 518 585 607 631 646 680 716 718 838 845
   914 917 929 934 252 336 704 743 828 910 919 980 984 216 220 234 326 330 380 419 440 513 567 614 740 937
   215 223 267 272 412 445 484 570 582 610 717 724 814 835 878 401 803 839 854 864 423 865 802
   276 434 540 571 703 757 804 826 948 304 681 850 906`,
);
// Eastern — Canada
assignZone(
  "America/Toronto",
  `226 249 289 343 365 416 437 519 613 647 683 705 742 753 807 905 942`,
);
assignZone(
  "America/Montreal",
  `354 367 418 438 450 468 514 579 581 819 873`,
);
// Atlantic / no-DST islands
assignZone("America/Puerto_Rico", "787 939");
assignZone("America/St_Thomas", "340");
assignZone("America/Halifax", "506 709 782 902");

// Central — US
assignZone(
  "America/Chicago",
  `205 251 256 334 659 938 327 479 501 870 217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 872
   319 515 563 641 712 316 620 785 913 225 318 337 504 985 218 320 507 612 651 763 952 228 601 662 769
   314 417 557 573 636 660 816 402 531 701 405 539 572 580 918 605 615 629 731 901 931
   210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979
   262 274 414 534 608 715 920 270 364 219`,
);
// Central — Canada
assignZone("America/Winnipeg", "204 584");
assignZone("America/Regina", "306 474 639"); // Saskatchewan: no DST

// Mountain
assignZone("America/Denver", "303 719 720 970 983 208 986 406 505 575 385 435 801 307 915 308");
assignZone("America/Phoenix", "480 520 602 623 928"); // Arizona: no DST
assignZone("America/Edmonton", "368 403 587 780 825");

// Pacific
assignZone(
  "America/Los_Angeles",
  `209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747
   760 764 805 818 820 831 837 840 858 909 916 925 949 951 702 725 775 458 503 541 971 206 253 360 425 509 564`,
);
assignZone("America/Vancouver", "236 250 257 604 672 778");

// Non-contiguous
assignZone("America/Anchorage", "907");
assignZone("Pacific/Honolulu", "808"); // Hawaii: no DST

/**
 * When the area code tells us nothing, satisfy the window in BOTH of these.
 *
 * A number could be anywhere in the continental US, so the only honest answer
 * is the intersection of the earliest and latest plausible zones. With a 9am–8pm
 * window that leaves noon–8pm Eastern, which is narrower than we would like and
 * exactly as narrow as not knowing deserves. Hawaii and Alaska are excluded on
 * purpose — including them collapses the window to nearly nothing, and an
 * unmapped code is far more likely to be a new continental overlay than a
 * Honolulu number.
 */
const UNKNOWN_ZONE_SAFE_ZONES = ["America/New_York", "America/Los_Angeles"] as const;

/** The zone an E.164 number probably sits in, or null when we can't tell. */
export function zoneForNumber(e164: string): string | null {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164);
  if (!m) return null; // Not NANP — we don't guess timezones for the rest of the world.
  return AREA_CODE_ZONES[m[1]] ?? null;
}

/**
 * The hour of day (0–23) that `at` falls on in `zone`.
 *
 * Uses Intl rather than a stored offset so DST is handled by the platform's
 * tzdata. `hourCycle: "h23"` matters: the default formatting of midnight in
 * some locales is "24", which would parse as an out-of-range hour and silently
 * shift a send by a day.
 */
export function hourIn(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = parts.find((p) => p.type === "hour")?.value;
  return Number(hour ?? 0);
}

export type QuietHours = {
  /** Inclusive. Sends are allowed from this local hour. */
  startHour: number;
  /** Exclusive. Sends stop at this local hour. */
  endHour: number;
};

/** Every zone a send to `e164` has to be simultaneously polite in. */
function zonesToSatisfy(e164: string): readonly string[] {
  const zone = zoneForNumber(e164);
  return zone ? [zone] : UNKNOWN_ZONE_SAFE_ZONES;
}

/** Is `at` inside the window for every zone this number might be in? */
export function isWithinQuietHours(
  e164: string,
  window: QuietHours,
  at: Date,
): boolean {
  return zonesToSatisfy(e164).every((zone) => {
    const h = hourIn(zone, at);
    return h >= window.startHour && h < window.endHour;
  });
}

/**
 * The soonest moment at or after `from` that it is polite to text this number.
 *
 * Returns `from` unchanged when it is already fine, which is the common case and
 * keeps a transactional send immediate. Otherwise it walks forward in
 * fifteen-minute steps to the next allowed instant.
 *
 * Fifteen minutes rather than an hour because an hourly walk lands every delayed
 * message on the hour, and a hundred texts leaving at exactly 09:00:00 is both a
 * throughput spike at the carrier and an obviously automated pattern. The step
 * also means the answer is never more than fifteen minutes later than legal.
 *
 * Bounded at 8 days of steps. A window that can never be satisfied — someone
 * sets start 20 and end 9, or the two safe zones have no overlap — must not spin
 * forever inside a cron invocation, so it gives up and returns null and the
 * caller parks the row with a readable reason instead.
 */
export function nextAllowedSend(
  e164: string,
  window: QuietHours,
  from: Date,
): Date | null {
  if (isWithinQuietHours(e164, window, from)) return from;

  const STEP_MS = 15 * 60 * 1000;
  const MAX_STEPS = (8 * 24 * 60) / 15;

  // Start from the next clean quarter-hour so repeated drains converge on the
  // same instants instead of drifting by however long the last one took.
  let t = new Date(Math.ceil(from.getTime() / STEP_MS) * STEP_MS);
  for (let i = 0; i < MAX_STEPS; i++) {
    if (isWithinQuietHours(e164, window, t)) return t;
    t = new Date(t.getTime() + STEP_MS);
  }
  return null;
}

/** For the composer: "Quiet hours — this will send at 9:00 AM Pacific." */
export function describeDelay(e164: string, at: Date): string {
  const zone = zoneForNumber(e164) ?? UNKNOWN_ZONE_SAFE_ZONES[0];
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}
