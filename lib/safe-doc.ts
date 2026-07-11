/**
 * Renders a plain-language SAFE-style memorandum from the offer fields.
 *
 * NOT a substitute for an actual YC SAFE — this is a memo summarizing
 * the deal terms in human-readable form so both sides can review what
 * they're committing to before counter-signing. The DocuSign-equivalent
 * is the e-sign workflow: the signers attest in the audit log + on the
 * offer row, with timestamps + names + IPs.
 */
export function renderSafeDoc(args: {
  investorName: string;
  teamName: string;
  amountCents: number;
  valuationCapCents: number | null;
  discountPct: number | null;
  mfn: boolean;
  proRata: boolean;
  notes: string | null;
}): string {
  const amount = (args.amountCents / 100).toLocaleString();
  const lines: string[] = [
    "# Simple Agreement for Future Equity — Summary",
    "",
    `**Investor:** ${args.investorName}`,
    `**Company:** ${args.teamName}`,
    `**Investment amount:** $${amount}`,
  ];
  if (args.valuationCapCents != null) {
    lines.push(
      `**Valuation cap:** $${(args.valuationCapCents / 100).toLocaleString()}`,
    );
  }
  if (args.discountPct != null) {
    lines.push(`**Discount rate:** ${args.discountPct}%`);
  }
  if (args.mfn) {
    lines.push("**Most-favored-nation (MFN):** Yes");
  }
  if (args.proRata) {
    lines.push("**Pro-rata rights:** Yes");
  }
  lines.push(
    "",
    "## Key terms",
    "",
    "- This SAFE converts to equity at the next priced equity round at the lower of (i) the discount-adjusted price per share, or (ii) the valuation cap price per share.",
    "- If the company is acquired or winds down before conversion, the Investor receives the greater of their investment back (cash) or the as-converted amount.",
    "- This SAFE is **non-voting** — the Investor does not gain board rights, information rights beyond the Sparkline Youth investor portal, or veto rights until conversion.",
    "",
    "## Process",
    "",
    "1. Investor signs first (already done by the time this document is generated).",
    "2. Company has 14 days to counter-sign or decline.",
    "3. On counter-sign, both parties receive a fully-executed copy via email and Sparkline Youth logs the signatures in the audit trail.",
    "",
    "## Important",
    "",
    "This is a real legal commitment. Before signing, founders should:",
    "- Read the term sheet line by line.",
    "- Run it past a parent / guardian / advisor.",
    "- Confirm dilution math with the Sparkline Youth team or an outside advisor.",
    "",
    "Counter-signing this document indicates the company accepts the terms above. If anything looks off, decline and request a revised offer.",
  );
  if (args.notes) {
    lines.push("", "## Additional terms", "", args.notes);
  }
  return lines.join("\n");
}
