import { createHash, randomUUID } from "node:crypto";
import type { AdapterFetchContext, AdapterRequest } from "../base";
import { createAdapterPhysicalSend } from "../physical-send";
import { credentialGeneration, getAccountSet } from "../../oauth/store";
import type { MirasimOAuthMetadata } from "../../oauth/types";
import {
  providerOutboundGet,
  providerOutboundPost,
  type ProviderOutboundDependencies,
} from "../../lib/provider-outbound";
import type { OcxProviderConfig } from "../../types";
import {
  createMirasimDeviceIdentity,
  sealedMirasimHeaders,
  signMirasimRequest,
} from "./crypto";

const DEVICE_SESSION_PATH = "/v1/device/session";
const TICKET_REFRESH_LEAD_MS = 2 * 60 * 1000;
const TICKET_DEFAULT_TTL_MS = 10 * 60 * 1000;
const TICKET_404_QUIET_MS = 60 * 1000;
const TICKET_501_QUIET_MS = 15 * 60 * 1000;
const MAX_CONTROL_BODY = 64 * 1024;
const INTERNAL_THREAD_HEADER = "x-opencodex-mirasim-thread";
const INTERNAL_WIRE_HEADER = "x-opencodex-mirasim-wire";
const CONTROL_PROVIDER_HEADER_NAMES = new Set(["x-mirasim-probe"]);

interface StoredMirasimCredential {
  accountSlotId: string;
  accountIdentity: string;
  generation: string;
  accessToken: string;
  metadata: MirasimOAuthMetadata;
}

interface TicketState {
  ticket?: string;
  expiresAt?: number;
  unmintableUntil?: number;
}

const ticketCache = new Map<string, TicketState>();
const sessionCache = new Map<string, string>();

function cleanMetadataValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 512 || /[\0\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function relaySubAccount(accessToken: string): string | undefined {
  const claims = decodeJwtClaims(accessToken);
  for (const name of ["account_id", "accountId"]) {
    const value = claims?.[name];
    if (typeof value === "string") {
      const clean = cleanMetadataValue(value);
      if (clean) return clean;
    }
  }
  return undefined;
}

function matchingCredential(accessToken: string): StoredMirasimCredential {
  const set = getAccountSet("mirasim");
  const matches = set?.accounts.filter(account => account.credential.access === accessToken) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "Mirasim OAuth credential changed before request dispatch; retry the request"
        : "Mirasim OAuth credential is ambiguous across account slots",
    );
  }
  const account = matches[0]!;
  const credential = account.credential;
  if (!credential.mirasim) throw new Error("Mirasim credential is missing device signing metadata");
  return {
    accountSlotId: account.id,
    accountIdentity: credential.accountId ?? account.id,
    generation: credentialGeneration(credential),
    accessToken,
    metadata: credential.mirasim,
  };
}

/**
 * Stable, non-secret cache scope for one Mirasim account/device pair. Access-token rotation must
 * not invalidate roster/model capabilities, while a re-login into another account or device
 * must never inherit them. Tests and pre-dispatch serializers may use synthetic tokens that are
 * not in the store yet, so fall back to a token fingerprint only when no stored credential exists.
 */
export function mirasimCredentialCacheScope(accessToken: string): string {
  const set = getAccountSet("mirasim");
  const matches = set?.accounts.filter(account => account.credential.access === accessToken) ?? [];
  if (matches.length === 0) {
    return createHash("sha256").update(accessToken).digest("hex");
  }
  if (matches.length > 1) {
    throw new Error("Mirasim OAuth credential is ambiguous across account slots");
  }
  const account = matches[0]!;
  const metadata = account.credential.mirasim;
  if (!metadata) throw new Error("Mirasim credential is missing device signing metadata");
  const deviceId = createMirasimDeviceIdentity(metadata.devicePrivateKey).deviceId;
  return createHash("sha256")
    .update([account.id, account.credential.accountId ?? account.id, deviceId].join("\0"))
    .digest("hex");
}

function ticketKey(credential: StoredMirasimCredential, deviceId: string): string {
  return createHash("sha256")
    .update([credential.accountSlotId, credential.generation, deviceId].join("\0"))
    .digest("hex");
}

function resolveTicketExpiry(now: number, payload: Record<string, unknown>): number {
  const expiresIn = payload.expiresIn ?? payload.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + Math.floor(expiresIn * 1000);
  }
  const expiresAt = payload.expiresAt ?? payload.expires_at;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    const candidate = Math.floor(expiresAt * 1000);
    if (candidate > now) return candidate;
  }
  return now + TICKET_DEFAULT_TTL_MS;
}

async function boundedControlJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_CONTROL_BODY) {
    throw new Error("Mirasim device-session response is too large");
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Mirasim device-session response is invalid");
  }
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function lowercaseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

async function mintDeviceTicket(
  credential: StoredMirasimCredential,
  ctx: AdapterFetchContext,
): Promise<{ credential: string; usedTicket: boolean }> {
  const identity = createMirasimDeviceIdentity(credential.metadata.devicePrivateKey);
  const key = ticketKey(credential, identity.deviceId);
  const state = ticketCache.get(key) ?? {};
  const now = Date.now();

  if (state.ticket && state.expiresAt && now < state.expiresAt - TICKET_REFRESH_LEAD_MS) {
    return { credential: state.ticket, usedTicket: true };
  }
  if (state.unmintableUntil && now < state.unmintableUntil) {
    return { credential: credential.accessToken, usedTicket: false };
  }

  const body = JSON.stringify({ publicKey: identity.publicKeyBase64, deviceId: identity.deviceId });
  const signed = signMirasimRequest({
    method: "POST",
    path: DEVICE_SESSION_PATH,
    deviceId: identity.deviceId,
    clientVersion: credential.metadata.clientVersion,
    credential: credential.accessToken,
    body: Buffer.from(body, "utf8"),
    privateKeyPem: identity.privateKeyPem,
  });
  const executor = ctx.executor ?? globalThis.fetch;
  const response = await executor(
    `${credential.metadata.relayUrl.replace(/\/$/, "")}${DEVICE_SESSION_PATH}`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${credential.accessToken}`,
        ...lowercaseHeaders(signed.headers),
      },
      body,
      signal: combineSignal(ctx.abortSignal, ctx.timeoutMs),
    },
  );

  if (response.status === 404 || response.status === 501) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    ticketCache.set(key, {
      unmintableUntil: now + (response.status === 404 ? TICKET_404_QUIET_MS : TICKET_501_QUIET_MS),
    });
    return { credential: credential.accessToken, usedTicket: false };
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    if (state.ticket && state.expiresAt && now < state.expiresAt) {
      return { credential: state.ticket, usedTicket: true };
    }
    throw new Error(`Mirasim device-session mint failed with HTTP ${response.status}`);
  }

  const payload = await boundedControlJson(response);
  const ticket = typeof payload.ticket === "string" ? payload.ticket.trim() : "";
  if (!ticket || ticket.length > MAX_CONTROL_BODY || /[\r\n\0]/.test(ticket)) {
    throw new Error("Mirasim device-session response contains an invalid ticket");
  }
  const expiresAt = resolveTicketExpiry(now, payload);
  ticketCache.set(key, { ticket, expiresAt });
  return { credential: ticket, usedTicket: true };
}

function cleanBaseHeaders(headers: Readonly<Record<string, string>>): {
  headers: Record<string, string>;
  threadId?: string;
} {
  const out: Record<string, string> = {};
  let threadId: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === INTERNAL_THREAD_HEADER) {
      threadId = cleanMetadataValue(value);
      continue;
    }
    if (lower === INTERNAL_WIRE_HEADER) continue;
    if (
      lower === "authorization"
      || lower === "proxy-authorization"
      || lower === "x-api-key"
      || lower.startsWith("x-mirasim-")
    ) continue;
    out[lower] = value;
  }
  return { headers: out, threadId };
}

function collectEnabled(): boolean {
  const value = process.env.MIRASIM_COLLECT?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function sessionId(cacheKey: string, accountIdentity: string, threadId: string | undefined): string {
  if (threadId) {
    return `mirasim_${createHash("sha256")
      .update(`${accountIdentity}\0${threadId}`)
      .digest("hex")
      .slice(0, 32)}`;
  }
  const existing = sessionCache.get(cacheKey);
  if (existing) return existing;
  const created = `mirasim_${randomUUID()}`;
  sessionCache.set(cacheKey, created);
  return created;
}

function inferenceMetadata(
  credential: StoredMirasimCredential,
  deviceId: string,
  requestPath: string,
  threadId?: string,
): Record<string, string> {
  const key = ticketKey(credential, deviceId);
  const metadata: Record<string, string> = {
    "x-mirasim-session": sessionId(key, credential.accountIdentity, threadId),
    "x-mirasim-agent": requestPath.startsWith("/v1/responses") || requestPath.startsWith("/v1/alpha/search")
      ? "codex"
      : "claude",
    "x-mirasim-call": randomUUID(),
  };
  const account = relaySubAccount(credential.accessToken);
  if (account) metadata["x-mirasim-account"] = account;
  const locale = cleanMetadataValue(process.env.MIRASIM_LOCALE);
  if (locale) metadata["x-mirasim-locale"] = locale;
  if (!collectEnabled()) metadata["x-mirasim-collect"] = "off";
  return metadata;
}

function assertRelayTarget(url: URL, configuredRelayUrl: string): void {
  const relay = new URL(configuredRelayUrl);
  if (url.origin !== relay.origin) {
    throw new Error("Mirasim request destination does not match the credential relay origin");
  }
}

async function buildPhysicalRequest(
  request: AdapterRequest,
  ctx: AdapterFetchContext,
  credential: StoredMirasimCredential,
  forceFreshTicket: boolean,
  controlPlane = false,
  controlCredentialMode: "device-ticket" | "access-token" = "device-ticket",
): Promise<{ init: RequestInit; usedTicket: boolean; url: string }> {
  const target = new URL(request.url);
  assertRelayTarget(target, credential.metadata.relayUrl);
  const path = target.pathname;
  const identity = createMirasimDeviceIdentity(credential.metadata.devicePrivateKey);
  const clean = cleanBaseHeaders(request.headers);
  if (forceFreshTicket && controlCredentialMode === "device-ticket") {
    ticketCache.delete(ticketKey(credential, identity.deviceId));
  }
  const auth = controlPlane && controlCredentialMode === "access-token"
    ? { credential: credential.accessToken, usedTicket: false }
    : await mintDeviceTicket(credential, ctx);
  const metadata = controlPlane
    ? undefined
    : inferenceMetadata(credential, identity.deviceId, path, clean.threadId);
  const signed = signMirasimRequest({
    method: request.method,
    path,
    deviceId: identity.deviceId,
    clientVersion: credential.metadata.clientVersion,
    credential: auth.credential,
    metadata,
    body: Buffer.from(request.body, "utf8"),
    privateKeyPem: identity.privateKeyPem,
  });
  const authenticatedHeaders = { ...clean.headers, ...signed.headers };
  const signedAndSealed = controlPlane
    ? lowercaseHeaders(authenticatedHeaders)
    : sealedMirasimHeaders(authenticatedHeaders, request.method, path);
  const method = request.method.toUpperCase();
  return {
    url: target.toString(),
    usedTicket: auth.usedTicket,
    init: {
      method: request.method,
      redirect: "manual",
      headers: { ...signedAndSealed, authorization: `Bearer ${auth.credential}` },
      ...(method === "GET" || method === "HEAD" ? {} : { body: request.body }),
      signal: ctx.abortSignal,
    },
  };
}

function providerControlExecutor(
  providerName: string,
  provider: OcxProviderConfig,
  dependencies: ProviderOutboundDependencies = {},
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (method === "GET") {
      return providerOutboundGet(providerName, provider, url, { headers, signal }, dependencies);
    }
    if (method === "POST") {
      const rawBody = init?.body;
      if (rawBody != null && typeof rawBody !== "string") {
        throw new Error("Mirasim control-plane POST body must be a UTF-8 string");
      }
      const body = rawBody ?? "";
      return providerOutboundPost(providerName, provider, url, { headers, body, signal }, dependencies);
    }
    throw new Error(`Mirasim control-plane method ${method} is not supported`);
  }) as typeof globalThis.fetch;
}

export interface MirasimControlRequestOptions {
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  /** Provider-owned headers appended after signing; caller-supplied x-mirasim-* remains blocked. */
  providerHeaders?: Readonly<Record<string, string>>;
  /**
   * Most relay control endpoints accept the device-session bearer used by inference. A small
   * account-scoped subset (currently /v1/model-roster) authenticates the login access token
   * directly instead. Both modes still carry the device signature.
   */
  credentialMode?: "device-ticket" | "access-token";
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  outboundDependencies?: ProviderOutboundDependencies;
}

function validatedControlProviderHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    const value = rawValue.trim();
    if (!CONTROL_PROVIDER_HEADER_NAMES.has(name)) {
      throw new Error(`Unsupported Mirasim provider-owned control header: ${rawName}`);
    }
    if (!value || value.length > 512 || /[\0\r\n]/.test(value)) {
      throw new Error(`Invalid Mirasim provider-owned control header: ${rawName}`);
    }
    out[name] = value;
  }
  return out;
}

function appendControlProviderHeaders(
  physical: { init: RequestInit; usedTicket: boolean; url: string },
  providerHeaders: Readonly<Record<string, string>>,
): void {
  if (Object.keys(providerHeaders).length === 0) return;
  const headers = new Headers(physical.init.headers);
  for (const [name, value] of Object.entries(providerHeaders)) headers.set(name, value);
  physical.init = { ...physical.init, headers };
}

/**
 * Send a Mirasim control-plane request without inference metadata or the sealed
 * x-mirasim-enc envelope. Device-ticket authentication remains the default; endpoints whose
 * control-plane contract is tied to the login identity can opt into the access-token credential
 * while retaining device signing.
 */
export async function fetchMirasimControl(
  providerName: string,
  provider: OcxProviderConfig,
  accessToken: string,
  path: string,
  options: MirasimControlRequestOptions = {},
): Promise<Response> {
  const credential = matchingCredential(accessToken);
  const relayBase = credential.metadata.relayUrl.replace(/\/$/, "");
  const normalizedPath = `/${path.trim().replace(/^\/+/, "")}`;
  const executor = providerControlExecutor(providerName, provider, options.outboundDependencies);
  const ctx: AdapterFetchContext = {
    executor,
    ...(options.signal ? { abortSignal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  const request: AdapterRequest = {
    url: `${relayBase}${normalizedPath}`,
    method: options.method ?? "GET",
    headers: { accept: "application/json", ...(options.headers ?? {}) },
    body: options.body ?? "",
  };
  const providerHeaders = validatedControlProviderHeaders(options.providerHeaders);
  const credentialMode = options.credentialMode ?? "device-ticket";
  let physical = await buildPhysicalRequest(
    request,
    ctx,
    credential,
    false,
    true,
    credentialMode,
  );
  appendControlProviderHeaders(physical, providerHeaders);
  let response = await executor(physical.url, physical.init);
  if (response.status !== 401 || !physical.usedTicket) return response;

  const replacement = await buildPhysicalRequest(
    request,
    ctx,
    credential,
    true,
    true,
    credentialMode,
  );
  appendControlProviderHeaders(replacement, providerHeaders);
  try { await response.body?.cancel(); } catch { /* already closed */ }
  physical = replacement;
  response = await executor(physical.url, physical.init);
  return response;
}

export async function fetchMirasim(
  request: AdapterRequest,
  accessToken: string,
  ctx: AdapterFetchContext = {},
): Promise<Response> {
  const credential = matchingCredential(accessToken);
  const send = createAdapterPhysicalSend(ctx);
  let physical = await buildPhysicalRequest(request, ctx, credential, false);
  const response = await send({
    url: physical.url,
    dispatch: executor => executor(physical.url, physical.init),
  });
  if (response.status !== 401 || !physical.usedTicket) return response;

  try {
    return await send({
      url: physical.url,
      sendClass: "auth-recovery",
      recovery: "oauth-401",
      beforeDispatch: async () => {
        // Build the replacement first. If re-minting fails the original 401 remains readable
        // rather than returning a Response whose body we already cancelled.
        const replacement = await buildPhysicalRequest(request, ctx, credential, true);
        try { await response.body?.cancel(); } catch { /* already closed */ }
        physical = replacement;
      },
      dispatch: executor => executor(physical.url, physical.init),
    });
  } catch (error) {
    if (!response.bodyUsed) return response;
    throw error;
  }
}

export const MIRASIM_INTERNAL_WIRE_HEADER = INTERNAL_WIRE_HEADER;
export const MIRASIM_INTERNAL_THREAD_HEADER = INTERNAL_THREAD_HEADER;

export function resetMirasimTransportStateForTests(): void {
  ticketCache.clear();
  sessionCache.clear();
}
