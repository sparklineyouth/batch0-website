/**
 * Run-scoped Discord REST transport for autonomous question answering.
 * No environment reads, database access, timers that sleep, or implicit writes.
 * Construct once per bounded job; only replyToMessage and the explicitly named
 * enableLimitedMessageContent method write to Discord.
 *
 * https://docs.discord.com/developers/events/gateway#message-content-intent
 * https://docs.discord.com/developers/resources/application#edit-current-application
 * https://docs.discord.com/developers/topics/permissions#permission-overwrites
 * https://docs.discord.com/developers/topics/threads#permissions
 * https://docs.discord.com/developers/resources/message#get-channel-messages
 * https://docs.discord.com/developers/topics/rate-limits
 */

export type DiscordTransportErrorKind =
  | "configuration" | "unauthorized" | "forbidden" | "not_found"
  | "rate_limit" | "budget" | "timeout" | "aborted" | "network"
  | "api" | "protocol" | "conflict" | "unsupported";

export class DiscordTransportError extends Error {
  readonly kind: DiscordTransportErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly global: boolean;
  readonly discordCode?: number;
  constructor(kind: DiscordTransportErrorKind, message: string, details: {
    status?: number; retryAfterMs?: number; global?: boolean; discordCode?: number;
  } = {}) {
    super(message);
    this.name = "DiscordTransportError";
    this.kind = kind;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.global = details.global ?? false;
    this.discordCode = details.discordCode;
  }
}

export interface DiscordTransportOptions {
  token: string;
  guildId: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRequests?: number;
  /** Injectable clock for rate-limit tests. */
  now?: () => number;
}
export interface DiscordHealth {
  botId: string;
  applicationId: string;
  /** Decimal original API flags field; pass back for optimistic intent updates. */
  applicationFlags: string;
  messageContentEnabled: boolean;
  messageContentLimited: boolean;
  messageContentApproved: boolean;
  approximateGuildCount: number | null;
  interactionsEndpointUrl: string | null;
}
export interface DiscordReadableChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  /** Category ancestor, including a thread's text/forum/media parent. */
  categoryId?: string | null;
  kind: "text" | "announcement" | "voice" | "stage" | "thread";
  canReply: boolean;
  archived: boolean;
  locked: boolean;
}
export interface DiscordDiscovery {
  botId: string;
  channels: DiscordReadableChannel[];
  skipped: { id: string; reason: string }[];
}
export interface DiscordMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorBot: boolean;
  webhookId: string | null;
  content: string;
  type: number;
  createdAt: string;
  referencedMessageId: string | null;
}
export interface DiscordMessagePage {
  /** Always oldest first, regardless of Discord's response order. */
  messages: DiscordMessage[];
  full: boolean;
  oldestId: string | null;
  newestId: string | null;
}
export interface DiscordMessageBatch {
  messages: DiscordMessage[];
  /** False means the gap is not fully fetched: DO NOT advance the after cursor. */
  complete: boolean;
  nextBefore: string | null;
  highWaterId: string | null;
}
export interface DiscordPermissionOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}
export interface DiscordRolePermissions { id: string; permissions: string }

const API = "https://discord.com/api/v10";
const ONE = BigInt(1);
const BITS = {
  administrator: ONE << BigInt(3), view: ONE << BigInt(10), send: ONE << BigInt(11),
  history: ONE << BigInt(16), connect: ONE << BigInt(20), threadSend: ONE << BigInt(38),
  contentApproved: ONE << BigInt(18), contentLimited: ONE << BigInt(19),
};
const ALL_PERMISSIONS = (ONE << BigInt(64)) - ONE;
type JsonObject = Record<string, unknown>;

function protocol(message: string): never { throw new DiscordTransportError("protocol", message); }
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return protocol("Discord returned an invalid object");
  return value as JsonObject;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return protocol("Discord returned an invalid array");
  return value;
}
function snowflake(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > ALL_PERMISSIONS)
    throw new DiscordTransportError("configuration", "Expected a Discord snowflake ID");
  return value;
}
function bits(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return protocol("Discord returned invalid permission bits");
  const parsed = BigInt(value);
  if (parsed > ALL_PERMISSIONS) return protocol("Discord returned unsupported permission bits");
  return parsed;
}
function numberOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new DiscordTransportError("configuration", "Transport option is outside its permitted bounds");
  return value;
}
function compareIds(a: {id: string}, b: {id: string}) { return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0; }
function has(value: bigint, required: bigint) { return (value & required) === required; }
function normalizeMessage(value: unknown, channelId: string): DiscordMessage {
  const m = object(value), author = object(m.author);
  if (m.channel_id !== channelId || typeof m.content !== "string" || typeof m.timestamp !== "string") return protocol("Discord returned an invalid channel message");
  const reference = m.message_reference ? object(m.message_reference) : {};
  return {id: snowflake(m.id), channelId, authorId: snowflake(author.id), authorBot: author.bot === true,
    webhookId: typeof m.webhook_id === "string" ? snowflake(m.webhook_id) : null,
    content: m.content, type: typeof m.type === "number" ? m.type : 0, createdAt: m.timestamp,
    referencedMessageId: typeof reference.message_id === "string" ? snowflake(reference.message_id) : null};
}

/** Role union → everyone overwrite → role-overwrite union → member overwrite. */
export function effectiveDiscordPermissions(args: {
  guildId: string; botId: string; roleIds: readonly string[];
  roles: readonly DiscordRolePermissions[]; overwrites?: readonly DiscordPermissionOverwrite[];
}): bigint {
  const memberRoles = new Set(args.roleIds);
  let permissions = BigInt(0);
  for (const role of args.roles) if (role.id === args.guildId || memberRoles.has(role.id)) permissions |= bits(role.permissions);
  if (has(permissions, BITS.administrator)) return ALL_PERMISSIONS;
  const overwrites = args.overwrites ?? [];
  const everyone = overwrites.find(o => o.id === args.guildId && o.type === 0);
  if (everyone) permissions = (permissions & ~bits(everyone.deny)) | bits(everyone.allow);
  let deny = BigInt(0), allow = BigInt(0);
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && overwrite.id !== args.guildId && memberRoles.has(overwrite.id)) {
      deny |= bits(overwrite.deny); allow |= bits(overwrite.allow);
    }
  }
  permissions = (permissions & ~deny) | allow;
  const member = overwrites.find(o => o.id === args.botId && o.type === 1);
  if (member) permissions = (permissions & ~bits(member.deny)) | bits(member.allow);
  return permissions;
}

export class DiscordAutoTransport {
  private readonly options: Required<Pick<DiscordTransportOptions, "token" | "guildId" | "timeoutMs" | "maxRequests">>;
  private readonly fetcher: typeof fetch;
  private readonly signal?: AbortSignal;
  private readonly now: () => number;
  private tail: Promise<void> = Promise.resolve();
  private used = 0;
  private globalBlockedUntil = 0;
  private readonly routeBuckets = new Map<string, string>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(options: DiscordTransportOptions) {
    if (!options.token || /[\r\n]/.test(options.token)) throw new DiscordTransportError("configuration", "A bot token is required");
    this.options = {token: options.token, guildId: snowflake(options.guildId),
      timeoutMs: numberOption(options.timeoutMs ?? 10_000, 1, 30_000),
      maxRequests: numberOption(options.maxRequests ?? 100, 1, 1000)};
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.signal = options.signal;
    this.now = options.now ?? Date.now;
  }
  get requestsUsed() { return this.used; }

  private async request(path: string, body?: JsonObject): Promise<unknown> {
    // Keep even independently requested operations sequential within a job.
    const result = this.tail.then(() => this.perform(path, body));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async perform(path: string, body?: JsonObject): Promise<unknown> {
    const method = body ? (path === "/applications/@me" ? "PATCH" : "POST") : "GET";
    const route = `${method} ${path.split("?")[0]}`;
    const major = path.match(/^\/(channels|guilds)\/(\d+)/)?.[0] ?? "application";
    const bucket = this.routeBuckets.get(route) ?? route;
    if (this.signal?.aborted) throw new DiscordTransportError("aborted", "Discord operation was aborted");
    const now = this.now();
    if (this.globalBlockedUntil > now) throw new DiscordTransportError("rate_limit", "Discord global rate limit is active", {retryAfterMs: this.globalBlockedUntil - now, global: true});
    if ((this.blockedUntil.get(bucket) ?? 0) > now) throw new DiscordTransportError("rate_limit", "Discord route rate limit is active", {retryAfterMs: this.blockedUntil.get(bucket)! - now});
    if (this.used >= this.options.maxRequests) throw new DiscordTransportError("budget", "Discord request budget exhausted");
    this.used++;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    this.signal?.addEventListener("abort", cancel, {once: true});
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetcher(`${API}${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: {Authorization: `Bot ${this.options.token}`, "Content-Type": "application/json"},
        body: body ? JSON.stringify(body) : undefined,
      });
      // A response body can stall too; retain the timeout until it is consumed.
      let data: unknown;
      try { data = await response.json(); } catch {
        if (controller.signal.aborted) throw new Error("aborted");
        if (response.ok) return protocol("Discord returned invalid JSON");
        data = {};
      }
      const returnedBucket = response.headers.get("x-ratelimit-bucket");
      const bucketKey = returnedBucket ? `${returnedBucket}:${major}` : bucket;
      if (returnedBucket) this.routeBuckets.set(route, bucketKey);
      const resetAfter = Number(response.headers.get("x-ratelimit-reset-after"));
      if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(resetAfter) && resetAfter > 0)
        this.blockedUntil.set(bucketKey, this.now() + Math.ceil(resetAfter * 1000));
      if (response.status === 429) {
        const json = data && typeof data === "object" ? data as JsonObject : {};
        const header = Number(response.headers.get("retry-after"));
        const delays = [json.retry_after, header, resetAfter].filter((delay): delay is number => typeof delay === "number" && Number.isFinite(delay) && delay > 0);
        const retryAfterMs = delays.length ? Math.ceil(Math.max(...delays) * 1000) : 1000;
        const global = json.global === true || response.headers.get("x-ratelimit-global") === "true" || response.headers.get("x-ratelimit-scope") === "global";
        if (global) this.globalBlockedUntil = this.now() + retryAfterMs;
        else this.blockedUntil.set(bucketKey, this.now() + retryAfterMs);
        throw new DiscordTransportError("rate_limit", "Discord requested a retry after its rate limit resets", {status: 429, retryAfterMs, global});
      }
      if (!response.ok) {
        const code = data && typeof data === "object" && typeof (data as JsonObject).code === "number" ? (data as JsonObject).code as number : undefined;
        const kind = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "api";
        // Never reflect provider bodies, token strings, or fetch exception text.
        throw new DiscordTransportError(kind, `Discord request failed with HTTP ${response.status}`, {status: response.status, discordCode: code});
      }
      return data;
    } catch (error) {
      if (error instanceof DiscordTransportError) throw error;
      if (this.signal?.aborted) throw new DiscordTransportError("aborted", "Discord operation was aborted");
      if (controller.signal.aborted) throw new DiscordTransportError("timeout", "Discord request timed out");
      throw new DiscordTransportError("network", "Discord network request failed");
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", cancel);
    }
  }

  private async application(): Promise<JsonObject> { return object(await this.request("/applications/@me")); }
  private applicationHealth(app: JsonObject, botId: string): DiscordHealth {
    if (!Number.isSafeInteger(app.flags) || Number(app.flags) < 0) return protocol("Discord returned unsupported application flags");
    const flags = BigInt(Number(app.flags));
    return {botId, applicationId: snowflake(app.id), applicationFlags: String(app.flags),
      messageContentLimited: has(flags, BITS.contentLimited), messageContentApproved: has(flags, BITS.contentApproved),
      messageContentEnabled: Boolean(flags & (BITS.contentLimited | BITS.contentApproved)),
      approximateGuildCount: typeof app.approximate_guild_count === "number" ? app.approximate_guild_count : null,
      interactionsEndpointUrl: typeof app.interactions_endpoint_url === "string" ? app.interactions_endpoint_url : null};
  }
  async health(): Promise<DiscordHealth> {
    const me = object(await this.request("/users/@me"));
    const app = await this.application();
    const health = this.applicationHealth(app, snowflake(me.id));
    if (health.botId !== health.applicationId || me.bot !== true) return protocol("Discord token does not identify the expected bot application");
    return health;
  }

  /** Explicit opt-in write helper; callers must independently authorize it.
   * Rechecks the exact original flags, preserves all existing bits, and verifies
   * the result. Only Discord's limited privileged flags are API-writable.
   */
  async enableLimitedMessageContent(expectedFlags: string): Promise<DiscordHealth> {
    if (!/^\d+$/.test(expectedFlags)) throw new DiscordTransportError("configuration", "Expected decimal application flags");
    const app = await this.application();
    const before = this.applicationHealth(app, snowflake(app.id));
    if (before.applicationFlags !== expectedFlags) throw new DiscordTransportError("conflict", "Application flags changed; review current flags before enabling the intent");
    if (before.messageContentEnabled) return before;
    if (before.approximateGuildCount !== null && before.approximateGuildCount >= 100)
      throw new DiscordTransportError("unsupported", "This app needs Discord approval for Message Content Intent");
    const next = BigInt(expectedFlags) | BITS.contentLimited;
    if (next > BigInt(Number.MAX_SAFE_INTEGER)) return protocol("Application flags exceed the supported integer range");
    const updated = object(await this.request("/applications/@me", {flags: Number(next)}));
    const result = this.applicationHealth(updated, before.botId);
    if (result.applicationId !== before.applicationId || result.applicationFlags !== String(next)) return protocol("Discord did not preserve the expected application flags");
    return result;
  }

  async discoverChannels(): Promise<DiscordDiscovery> {
    const guild = this.options.guildId;
    const me = object(await this.request("/users/@me"));
    const botId = snowflake(me.id);
    const member = object(await this.request(`/guilds/${guild}/members/${botId}`));
    const roleIds = array(member.roles).map(snowflake);
    const roles = array(await this.request(`/guilds/${guild}/roles`)).map(r => {
      const row = object(r); bits(row.permissions); return {id: snowflake(row.id), permissions: row.permissions as string};
    });
    const rawChannels = array(await this.request(`/guilds/${guild}/channels`)).map(object);
    const active = object(await this.request(`/guilds/${guild}/threads/active`));
    const threads = array(active.threads).map(object);
    const joinedThreads = new Set(array(active.members).map(object).filter(m => m.user_id === undefined || m.user_id === botId).map(m => snowflake(m.id)));
    const parents = new Map(rawChannels.map(c => [snowflake(c.id), c]));
    const result: DiscordDiscovery = {botId, channels: [], skipped: []};
    const timedOut = typeof member.communication_disabled_until === "string" && Date.parse(member.communication_disabled_until) > this.now();
    const seen = new Set<string>();
    for (const channel of [...rawChannels, ...threads]) {
      const id = snowflake(channel.id); if (seen.has(id)) continue; seen.add(id);
      const type = Number(channel.type);
      if (![0, 2, 5, 10, 11, 12, 13].includes(type)) continue; // categories/forum containers have no messages of their own
      const isThread = [10, 11, 12].includes(type);
      const parentId = typeof channel.parent_id === "string" ? snowflake(channel.parent_id) : null;
      const permissionChannel = isThread ? parents.get(parentId ?? "") : channel;
      if (!permissionChannel) { result.skipped.push({id, reason: "missing_parent"}); continue; }
      if (type === 12 && !joinedThreads.has(id)) { result.skipped.push({id, reason: "private_thread_not_joined"}); continue; }
      const overwrites = array(permissionChannel.permission_overwrites ?? []).map(o => {
        const row = object(o); bits(row.allow); bits(row.deny);
        return {id: snowflake(row.id), type: Number(row.type), allow: row.allow as string, deny: row.deny as string};
      });
      const permissions = effectiveDiscordPermissions({guildId: guild, botId, roleIds, roles, overwrites});
      const voice = type === 2 || type === 13;
      const readBits = BITS.view | BITS.history | (voice ? BITS.connect : BigInt(0));
      if (!has(permissions, readBits)) { result.skipped.push({id, reason: "cannot_read_history"}); continue; }
      const metadata = channel.thread_metadata ? object(channel.thread_metadata) : {};
      const archived = isThread && metadata.archived === true, locked = isThread && metadata.locked === true;
      const ancestor = isThread ? permissionChannel.parent_id : channel.parent_id;
      const categoryId = typeof ancestor === "string" && parents.get(ancestor)?.type === 4 ? ancestor : null;
      result.channels.push({id, name: typeof channel.name === "string" ? channel.name : "", type, parentId, categoryId,
        kind: isThread ? "thread" : type === 5 ? "announcement" : type === 2 ? "voice" : type === 13 ? "stage" : "text",
        canReply: !timedOut && !archived && !locked && has(permissions, isThread ? BITS.threadSend : BITS.send), archived, locked});
    }
    return result;
  }

  async fetchMessages(channelId: string, options: {after?: string; before?: string; limit?: number} = {}): Promise<DiscordMessagePage> {
    const id = snowflake(channelId), limit = numberOption(options.limit ?? 100, 1, 100);
    if (options.after && options.before) throw new DiscordTransportError("configuration", "Discord after and before cursors are mutually exclusive");
    const query = new URLSearchParams({limit: String(limit)});
    if (options.after) query.set("after", snowflake(options.after));
    if (options.before) query.set("before", snowflake(options.before));
    const raw = array(await this.request(`/channels/${id}/messages?${query}`));
    const messages = raw.map(value => normalizeMessage(value, id)).sort(compareIds);
    return {messages, full: raw.length >= limit, oldestId: messages[0]?.id ?? null, newestId: messages.at(-1)?.id ?? null};
  }

  /** Re-read immediately before replying; a deleted source yields typed not_found. */
  async fetchMessage(channelId: string, messageId: string): Promise<DiscordMessage> {
    const channel = snowflake(channelId), message = snowflake(messageId);
    const result = normalizeMessage(await this.request(`/channels/${channel}/messages/${message}`), channel);
    if (result.id !== message) return protocol("Discord returned an unexpected source message");
    return result;
  }

  /** Reads a closed gap, including older pages when Discord returns newest first.
   * A full after-page cannot safely advance the cursor on its own. Follow before
   * pages until reaching the original cursor; never combine after and before.
   */
  async fetchAfter(channelId: string, after: string, options: {limit?: number; maxPages?: number} = {}): Promise<DiscordMessageBatch> {
    snowflake(after);
    const maxPages = numberOption(options.maxPages ?? 5, 1, 20);
    const messages = new Map<string, DiscordMessage>();
    let page = await this.fetchMessages(channelId, {after, limit: options.limit});
    const highWaterId = page.newestId;
    let complete = false, nextBefore: string | null = null;
    for (let count = 1; ; count++) {
      for (const message of page.messages) if (BigInt(message.id) > BigInt(after)) messages.set(message.id, message);
      if (!page.full || page.messages.length === 0 || BigInt(page.oldestId!) <= BigInt(after)) { complete = true; nextBefore = null; break; }
      if (nextBefore !== null && BigInt(page.oldestId!) >= BigInt(nextBefore)) return protocol("Discord pagination made no progress");
      nextBefore = page.oldestId;
      if (count >= maxPages) break;
      page = await this.fetchMessages(channelId, {before: nextBefore!, limit: options.limit});
    }
    return {messages: [...messages.values()].sort(compareIds), complete, nextBefore, highWaterId};
  }

  async replyToMessage(args: {channelId: string; messageId: string; content: string}): Promise<{id: string; channelId: string}> {
    const channelId = snowflake(args.channelId), messageId = snowflake(args.messageId);
    if (typeof args.content !== "string" || !args.content.trim() || args.content.length > 2000)
      throw new DiscordTransportError("configuration", "A Discord reply must contain 1–2000 characters");
    const result = object(await this.request(`/channels/${channelId}/messages`, {
      content: args.content, nonce: messageId, enforce_nonce: true,
      allowed_mentions: {parse: [], replied_user: false},
      message_reference: {message_id: messageId, channel_id: channelId, fail_if_not_exists: true},
    }));
    if (result.channel_id !== channelId) return protocol("Discord returned a reply in an unexpected channel");
    return {id: snowflake(result.id), channelId};
  }
}
