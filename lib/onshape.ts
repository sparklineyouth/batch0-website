// Onshape REST client: encode a configuration, export a Part Studio to STL.
//
// Shared by the local script (scripts/mint-cards.mts) and the admin mint route
// (app/api/admin/passes/mint/route.ts). One implementation on purpose — these
// two mint identical cards, and a copy-paste fork would drift exactly where it
// hurts most (the redirect/auth rule below, which took a real 401 to discover).
//
// Deliberately NOT imported by any page or component. The site's read paths
// never talk to Onshape: a card's geometry is frozen the moment it's printed,
// so a runtime CAD dependency would add latency and a failure mode for nothing.
// Only the admin mint action reaches for this.

const BASE = "https://cad.onshape.com/api/v6";

export type OnshapeConfig = {
  documentId: string;
  workspaceId: string;
  elementId: string;
  configParam: string;
};

/** Read Onshape settings from the environment, or null when unconfigured. */
export function onshapeConfigFromEnv(): OnshapeConfig | null {
  const documentId = process.env.ONSHAPE_DOCUMENT_ID;
  const workspaceId = process.env.ONSHAPE_WORKSPACE_ID;
  const elementId = process.env.ONSHAPE_ELEMENT_ID;
  if (!documentId || !workspaceId || !elementId) return null;
  if (!process.env.ONSHAPE_ACCESS_KEY || !process.env.ONSHAPE_SECRET_KEY) return null;
  return {
    documentId,
    workspaceId,
    elementId,
    configParam: process.env.ONSHAPE_CONFIG_PARAM || "cardCode",
  };
}

/**
 * Onshape accepts API keys as HTTP Basic (access key : secret key). Their docs
 * also describe an HMAC request-signing scheme; that exists for OAuth apps and
 * untrusted clients. For server-to-server with our own keys, Basic is the
 * supported and simpler path.
 */
export function onshapeAuthHeader(): string {
  const access = process.env.ONSHAPE_ACCESS_KEY;
  const secret = process.env.ONSHAPE_SECRET_KEY;
  if (!access || !secret) {
    throw new Error("ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY are not set");
  }
  return `Basic ${Buffer.from(`${access}:${secret}`).toString("base64")}`;
}

/**
 * Headers for following an Onshape export redirect.
 *
 * The STL endpoint answers 307 to a REGIONAL Onshape API host (e.g.
 * cad-usw2.onshape.com), NOT to a pre-signed storage URL — so the target still
 * demands credentials, and dropping the Authorization header there earns a flat
 * 401 on every card. (Onshape forum threads advise against re-sending auth on
 * this redirect. That advice does not match what the API does today; verified
 * empirically via `npm run onshape-doctor -- --test-export`, which exists for
 * exactly this reason — rerun it if this ever starts 401ing again.)
 *
 * Credentials are attached ONLY to onshape.com hosts over https. Because we
 * hand-follow a Location we did not choose, blindly replaying an API secret to
 * whatever host it names is how credentials leak. The suffix check uses a
 * leading dot so "evil-onshape.com" cannot match.
 */
function redirectHeaders(location: string): Record<string, string> {
  const { host, protocol } = new URL(location);
  const isOnshape = host === "onshape.com" || host.endsWith(".onshape.com");
  if (!isOnshape || protocol !== "https:") return {};
  return { Authorization: onshapeAuthHeader() };
}

async function onshapeJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: onshapeAuthHeader(),
      Accept: "application/json;charset=UTF-8; qs=0.09",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Onshape ${init.method ?? "GET"} ${path} -> ${res.status}\n${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

type ConfigParam = { parameterId: string; parameterName?: string };

/**
 * Verify the configuration input we're about to drive actually exists.
 *
 * Worth the round trip: a typo'd parameter name does NOT error. Onshape
 * ignores an unknown parameter and cheerfully exports the default
 * configuration, so you get a stack of STLs that all say the same thing and
 * only discover it after printing.
 *
 * Note the limit — this proves the input EXISTS, not that the Text sketch is
 * bound to it. Only a human looking at the geometry can confirm that.
 */
export async function preflightConfigParam(cfg: OnshapeConfig): Promise<void> {
  const res = await onshapeJson<{ configurationParameters?: ConfigParam[] }>(
    `/elements/d/${cfg.documentId}/w/${cfg.workspaceId}/e/${cfg.elementId}/configuration`,
  );
  const params = res.configurationParameters ?? [];
  if (!params.some((p) => p.parameterId === cfg.configParam)) {
    const names = params.map((p) => p.parameterId).join(", ") || "(none)";
    throw new Error(
      `Onshape Part Studio has no configuration parameter "${cfg.configParam}". Found: ${names}. ` +
        `Add a Configuration variable of Type "Text" named "${cfg.configParam}" and bind the Text ` +
        `sketch to it via "Configure text".`,
    );
  }
}

/** Encode { param: value } into the queryParam Onshape wants on export URLs. */
export async function encodeConfiguration(
  cfg: OnshapeConfig,
  value: string,
): Promise<string> {
  const res = await onshapeJson<{ queryParam: string; encodedId: string }>(
    `/elements/d/${cfg.documentId}/e/${cfg.elementId}/configurationencodings`,
    {
      method: "POST",
      body: JSON.stringify({
        parameters: [{ parameterId: cfg.configParam, parameterValue: value }],
      }),
    },
  );
  return res.queryParam;
}

/** Export one configuration of the Part Studio as a binary STL. */
export async function exportStl(
  cfg: OnshapeConfig,
  queryParam: string,
): Promise<Buffer> {
  const url =
    `${BASE}/partstudios/d/${cfg.documentId}/w/${cfg.workspaceId}/e/${cfg.elementId}/stl` +
    `?mode=binary&grouping=true&units=millimeter&${queryParam}`;

  const res = await fetch(url, {
    headers: {
      Authorization: onshapeAuthHeader(),
      Accept: "application/vnd.onshape.v1+octet-stream",
    },
    // Manual so the credential rule above is explicit rather than left to
    // fetch's default cross-origin header stripping.
    redirect: "manual",
  });

  let bytes: Buffer;
  if (res.status === 307 || res.status === 302 || res.status === 301) {
    const location = res.headers.get("location");
    if (!location) throw new Error("Onshape STL export: redirect with no Location header");
    const follow = await fetch(location, { headers: redirectHeaders(location) });
    if (!follow.ok) {
      throw new Error(
        `Onshape STL download -> ${follow.status} from ${new URL(location).host}. ` +
          `Run: npm run onshape-doctor -- --test-export`,
      );
    }
    bytes = Buffer.from(await follow.arrayBuffer());
  } else if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Onshape STL export -> ${res.status}\n${body.slice(0, 300)}`);
  } else {
    bytes = Buffer.from(await res.arrayBuffer());
  }

  // A binary STL is an 80-byte header + a uint32 triangle count. Checking it
  // catches downloading *something* (200, plausible size) that isn't geometry —
  // an error page, an empty configuration. Fail on card 1 rather than handing
  // 50 unprintable files to a printer.
  const triangles = bytes.length >= 84 ? bytes.readUInt32LE(80) : 0;
  if (triangles === 0) {
    throw new Error(
      `Onshape returned ${bytes.length} bytes with 0 triangles — that isn't geometry. ` +
        `Check the Part Studio builds for this configuration.`,
    );
  }
  return bytes;
}

/** Convenience: encode a code and export its STL in one call. */
export async function exportCardStl(
  cfg: OnshapeConfig,
  code: string,
): Promise<Buffer> {
  const queryParam = await encodeConfiguration(cfg, code);
  return exportStl(cfg, queryParam);
}
