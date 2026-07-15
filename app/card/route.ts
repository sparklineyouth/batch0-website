import { NextResponse, type NextRequest } from "next/server";

/**
 * /card -> /pass, preserving the query string.
 *
 * The canonical route is /pass, but the cards are physical objects that were
 * printed before this code existed: whatever URL is embossed on them is now
 * permanent and unfixable. Serving both costs one file and removes an entire
 * class of "the URL on the card 404s" that we could not correct after the
 * fact. Cloning nextUrl keeps ?code=XXXX intact so a QR pointing at
 * /card?code=... lands on the form pre-filled.
 *
 * 307 rather than a permanent redirect: /card is a real, supported entry point
 * we may want to serve differently later, and a 308 would be cached in the
 * browsers of exactly the people holding cards.
 */
export function GET(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/pass";
  return NextResponse.redirect(url, 307);
}
