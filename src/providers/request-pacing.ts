import type { OcxProviderConfig, RequestPacingRule } from "../types";
import type { GenerationContext } from "../lib/state-store-sweeper";

export const REQUEST_PACING_MAX_QUEUE_DEPTH = 256;
export const REQUEST_PACING_MAX_QUEUE_AGE_MS = 60_000;

let maxQueueDepth = REQUEST_PACING_MAX_QUEUE_DEPTH;
let maxQueueAgeMs = REQUEST_PACING_MAX_QUEUE_AGE_MS;

export type RequestPacingQueueOverloadReason = "queue_full" | "queue_expired";

export class RequestPacingQueueOverloadError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly reason: RequestPacingQueueOverloadReason,
    public readonly retryAfterSeconds: number,
  ) {
    super(reason === "queue_full"
      ? `request pacing queue for provider '${providerName}' is full`
      : `request pacing queue for provider '${providerName}' exceeded the maximum queued age`);
    this.name = "RequestPacingQueueOverloadError";
  }
}

export class RequestPacingProviderRemovedError extends Error {
  constructor(public readonly providerName: string) {
    super(`request pacing provider '${providerName}' was removed`);
    this.name = "RequestPacingProviderRemovedError";
  }
}

interface Waiter {
  modelId?: string;
  providerIntervalMs: number;
  modelIntervalMs: number;
  providerMaxConcurrent: number;
  modelMaxConcurrent: number;
  queuedAt: number;
  signal?: AbortSignal;
  resolve: (slot: ProviderRequestSlot) => void;
  reject: (reason: unknown) => void;
  abort?: () => void;
}

interface ProviderPacer {
  queue: Waiter[];
  providerNextStartAt: number;
  modelNextStartAt: Map<string, number>;
  providerInFlight: number;
  modelInFlight: Map<string, number>;
  timer?: unknown;
  lastStartedAt?: number;
  lastModelId?: string;
}

/**
 * Lease returned by waitForProviderRequestSlot. Inert unless the provider (or the
 * request model override) sets maxConcurrentRequests; then release() returns the
 * concurrency slot when the upstream request finishes, whether that is body completion,
 * body cancellation, or a send that never produced a response.
 */
export interface ProviderRequestSlot {
  /**
   * True only when this slot holds a concurrency lease whose release must follow the
   * upstream body lifecycle. Interval-only slots stay inert so response objects keep
   * their identity through the fetch path.
   */
  readonly leased: boolean;
  /** Idempotent. Safe to call from body completion, cancellation, and error paths alike. */
  release(): void;
}

const inertProviderRequestSlot: ProviderRequestSlot = { leased: false, release() {} };

export interface RequestPacingRuntime {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  enqueueMicrotask: (callback: () => void) => void;
}

export interface ProviderRequestPacingStatus {
  provider: string;
  enabled: boolean;
  queued: number;
  nextSlotInMs: number;
  inFlight?: number;
  lastStartedAt?: number;
  lastModelId?: string;
}

const pacers = new Map<string, ProviderPacer>();
const defaultRuntime: RequestPacingRuntime = {
  now: Date.now,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  enqueueMicrotask: queueMicrotask,
};
let runtime = defaultRuntime;
let lastReconciledGeneration = 0;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function normalizedInterval(rule: RequestPacingRule | undefined): number {
  if (!rule) return 0;
  const rpmInterval = typeof rule.requestsPerMinute === "number" && rule.requestsPerMinute > 0
    ? 60_000 / rule.requestsPerMinute
    : 0;
  const fixedInterval = typeof rule.minIntervalMs === "number" && rule.minIntervalMs > 0
    ? rule.minIntervalMs
    : 0;
  return Math.max(rpmInterval, fixedInterval);
}

function normalizedMaxConcurrent(rule: RequestPacingRule | undefined): number {
  return typeof rule?.maxConcurrentRequests === "number" && rule.maxConcurrentRequests > 0
    ? rule.maxConcurrentRequests
    : 0;
}

export function requestPacingIntervalMs(provider: OcxProviderConfig, modelId?: string): number {
  const policy = provider.requestPacing;
  if (!policy?.enabled) return 0;
  const override = modelId ? policy.models?.[modelId] : undefined;
  return Math.max(normalizedInterval(policy), normalizedInterval(override));
}

function requestPacingIntervals(provider: OcxProviderConfig, modelId?: string): {
  providerIntervalMs: number;
  modelIntervalMs: number;
  providerMaxConcurrent: number;
  modelMaxConcurrent: number;
} {
  const policy = provider.requestPacing;
  if (!policy?.enabled) {
    return { providerIntervalMs: 0, modelIntervalMs: 0, providerMaxConcurrent: 0, modelMaxConcurrent: 0 };
  }
  return {
    providerIntervalMs: normalizedInterval(policy),
    modelIntervalMs: modelId ? normalizedInterval(policy.models?.[modelId]) : 0,
    providerMaxConcurrent: normalizedMaxConcurrent(policy),
    modelMaxConcurrent: modelId ? normalizedMaxConcurrent(policy.models?.[modelId]) : 0,
  };
}

export function requestPacingMaxConcurrentRequests(provider: OcxProviderConfig, modelId?: string): number {
  const limits = requestPacingIntervals(provider, modelId);
  return Math.max(limits.providerMaxConcurrent, limits.modelMaxConcurrent);
}

function waiterReadyAt(state: ProviderPacer, modelId: string | undefined): number {
  return Math.max(
    state.providerNextStartAt,
    modelId ? (state.modelNextStartAt.get(modelId) ?? 0) : 0,
  );
}

function pacingRetryAfterSeconds(state: ProviderPacer, modelId: string | undefined, now: number): number {
  return Math.max(1, Math.ceil(Math.max(0, waiterReadyAt(state, modelId) - now) / 1000));
}

function makeProviderRequestSlot(providerName: string, state: ProviderPacer, waiter: Waiter): ProviderRequestSlot {
  let released = false;
  const leased = waiter.providerMaxConcurrent > 0 || waiter.modelMaxConcurrent > 0;
  return {
    leased,
    release() {
      if (released) return;
      released = true;
      if (waiter.providerMaxConcurrent > 0 && state.providerInFlight > 0) state.providerInFlight -= 1;
      if (waiter.modelId && waiter.modelMaxConcurrent > 0) {
        const current = state.modelInFlight.get(waiter.modelId) ?? 0;
        if (current <= 1) state.modelInFlight.delete(waiter.modelId);
        else state.modelInFlight.set(waiter.modelId, current - 1);
      }
      runtime.enqueueMicrotask(() => {
        // A pending wake-up timer makes runQueue defer to it, but the lease that just
        // returned may admit a waiter the timer was never scheduled for, so take over.
        if (state.timer) {
          runtime.clearTimer(state.timer);
          state.timer = undefined;
        }
        runQueue(providerName, state);
      });
    },
  };
}

function rejectExpiredWaiters(providerName: string, state: ProviderPacer, now: number): void {
  for (let index = state.queue.length - 1; index >= 0; index -= 1) {
    const waiter = state.queue[index]!;
    if (now - waiter.queuedAt < maxQueueAgeMs) continue;
    state.queue.splice(index, 1);
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.reject(new RequestPacingQueueOverloadError(
      providerName,
      "queue_expired",
      pacingRetryAfterSeconds(state, waiter.modelId, now),
    ));
  }
}

function removeProviderPacer(providerName: string, state: ProviderPacer): void {
  if (state.timer) runtime.clearTimer(state.timer);
  state.timer = undefined;
  pacers.delete(providerName);
  const waiters = state.queue.splice(0);
  const error = new RequestPacingProviderRemovedError(providerName);
  for (const waiter of waiters) {
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.reject(error);
  }
}

function runQueue(providerName: string, state: ProviderPacer): void {
  if (state.queue.length === 0) {
    if (state.timer) runtime.clearTimer(state.timer);
    state.timer = undefined;
    return;
  }
  if (state.timer) return;
  const now = runtime.now();
  for (const [modelId, readyAt] of state.modelNextStartAt) {
    if (readyAt <= now) state.modelNextStartAt.delete(modelId);
  }
  rejectExpiredWaiters(providerName, state, now);
  if (state.queue.length === 0) return;

  const providerReadyAt = Math.max(now, state.providerNextStartAt);
  const waiterIndex = state.queue.findIndex(waiter => {
    if (waiter.providerMaxConcurrent > 0 && state.providerInFlight >= waiter.providerMaxConcurrent) return false;
    if (waiter.modelId && waiter.modelMaxConcurrent > 0
      && (state.modelInFlight.get(waiter.modelId) ?? 0) >= waiter.modelMaxConcurrent) return false;
    const modelReadyAt = waiter.modelId ? (state.modelNextStartAt.get(waiter.modelId) ?? 0) : 0;
    return Math.max(providerReadyAt, modelReadyAt) <= now;
  });
  if (waiterIndex < 0) {
    let earliestAt = Number.POSITIVE_INFINITY;
    for (const waiter of state.queue) {
      const modelReadyAt = waiter.modelId ? (state.modelNextStartAt.get(waiter.modelId) ?? 0) : 0;
      const readyAt = Math.max(providerReadyAt, modelReadyAt);
      const expiresAt = waiter.queuedAt + maxQueueAgeMs;
      // A waiter whose start time already passed is blocked on an in-flight lease; its release
      // re-runs this queue through a microtask, so the timer only needs its expiry backstop.
      // Scheduling for its readyAt (in the past) would spin the timer on every empty pass.
      earliestAt = Math.min(earliestAt, readyAt <= now ? Number.POSITIVE_INFINITY : readyAt, expiresAt);
    }
    if (!Number.isFinite(earliestAt)) return;
    const delayMs = Math.max(0, earliestAt - now);
    state.timer = runtime.setTimer(() => {
      state.timer = undefined;
      runQueue(providerName, state);
    }, delayMs);
    return;
  }
  const waiter = state.queue[waiterIndex]!;
  state.queue.splice(waiterIndex, 1);
  if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  const startedAt = runtime.now();
  state.lastStartedAt = startedAt;
  state.lastModelId = waiter.modelId;
  state.providerNextStartAt = startedAt + waiter.providerIntervalMs;
  if (waiter.modelId && waiter.modelIntervalMs > 0) {
    state.modelNextStartAt.set(waiter.modelId, startedAt + waiter.modelIntervalMs);
  }
  if (waiter.providerMaxConcurrent > 0) state.providerInFlight += 1;
  if (waiter.modelId && waiter.modelMaxConcurrent > 0) {
    state.modelInFlight.set(waiter.modelId, (state.modelInFlight.get(waiter.modelId) ?? 0) + 1);
  }
  waiter.resolve(makeProviderRequestSlot(providerName, state, waiter));
  runtime.enqueueMicrotask(() => runQueue(providerName, state));
}

export async function waitForProviderRequestSlot(
  providerName: string,
  provider: OcxProviderConfig,
  modelId?: string,
  signal?: AbortSignal,
): Promise<ProviderRequestSlot> {
  const intervals = requestPacingIntervals(provider, modelId);
  const paced = Math.max(intervals.providerIntervalMs, intervals.modelIntervalMs) > 0
    || intervals.providerMaxConcurrent > 0
    || intervals.modelMaxConcurrent > 0;
  if (!paced) return inertProviderRequestSlot;
  if (signal?.aborted) throw abortReason(signal);

  const state = pacers.get(providerName) ?? {
    queue: [], providerNextStartAt: 0, modelNextStartAt: new Map<string, number>(),
    providerInFlight: 0, modelInFlight: new Map<string, number>(),
  };
  pacers.set(providerName, state);

  // Give already-eligible or expired waiters a chance to leave before applying the
  // admission bound to the newest request. This preserves FIFO-ish fairness while
  // keeping the retained queue strictly bounded under burst load.
  if (state.timer) {
    runtime.clearTimer(state.timer);
    state.timer = undefined;
  }
  runQueue(providerName, state);
  if (state.queue.length >= maxQueueDepth) {
    throw new RequestPacingQueueOverloadError(
      providerName,
      "queue_full",
      pacingRetryAfterSeconds(state, modelId, runtime.now()),
    );
  }

  return await new Promise<ProviderRequestSlot>((resolve, reject) => {
    const waiter: Waiter = {
      modelId,
      ...intervals,
      queuedAt: runtime.now(),
      signal,
      resolve,
      reject,
    };
    waiter.abort = () => {
      const index = state.queue.indexOf(waiter);
      if (index >= 0) state.queue.splice(index, 1);
      if (state.timer) {
        runtime.clearTimer(state.timer);
        state.timer = undefined;
      }
      reject(abortReason(signal!));
      runQueue(providerName, state);
    };
    signal?.addEventListener("abort", waiter.abort, { once: true });
    state.queue.push(waiter);
    // Abort may race between the eager check above and listener registration.
    if (signal?.aborted) {
      waiter.abort();
      return;
    }
    if (state.timer) {
      runtime.clearTimer(state.timer);
      state.timer = undefined;
    }
    runQueue(providerName, state);
  });
}

/**
 * Tie a pacing slot lease to an upstream response body: the lease is released when the
 * body completes, errors, or is cancelled by the consumer. A null body (204/304/HEAD)
 * means the exchange is already finished, so the lease returns immediately.
 *
 * Caveat: a caller that neither reads nor cancels the returned body keeps the lease; the
 * abort paths that cancel abandoned streams are the backstop. The returned Response
 * preserves status, statusText, and headers.
 */
export function trackProviderRequestSlotBody(
  slot: ProviderRequestSlot | undefined,
  response: Response,
): Response {
  // An unleased slot has nothing to return on body close, and rewrapping the Response
  // would break identity-based markers (the eager WS relay registry is a WeakSet).
  if (!slot?.leased) return response;
  if (!response.body) {
    slot.release();
    return response;
  }
  const source = response.body;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    slot.release();
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const tracked = new ReadableStream<Uint8Array>({
    pull: async controller => {
      reader ??= source.getReader();
      try {
        const { done, value } = await reader.read();
        // A consumer cancel while this read was pending resolves it (done or a late chunk);
        // touching the cancelled controller would throw from the pull algorithm.
        if (cancelled) return;
        if (done) {
          controller.close();
          release();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (cancelled) return;
        release();
        controller.error(error);
      }
    },
    cancel: reason => {
      cancelled = true;
      release();
      return (reader ?? source).cancel(reason);
    },
  });
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function providerRequestPacingStatus(
  providerName: string,
  provider: OcxProviderConfig,
  now = runtime.now(),
): ProviderRequestPacingStatus {
  const state = pacers.get(providerName);
  let nextSlotAt = state?.providerNextStartAt ?? 0;
  if (state && state.queue.length > 0) {
    let earliestQueuedSlotAt = Number.POSITIVE_INFINITY;
    for (const waiter of state.queue) {
      earliestQueuedSlotAt = Math.min(earliestQueuedSlotAt, waiterReadyAt(state, waiter.modelId));
    }
    if (Number.isFinite(earliestQueuedSlotAt)) nextSlotAt = earliestQueuedSlotAt;
  }
  const providerConcurrencyCap = requestPacingMaxConcurrentRequests(provider);
  const anyConcurrencyCap = providerConcurrencyCap > 0
    || Object.values(provider.requestPacing?.models ?? {}).some(rule => normalizedMaxConcurrent(rule) > 0);
  return {
    provider: providerName,
    enabled: provider.requestPacing?.enabled === true,
    queued: state?.queue.length ?? 0,
    nextSlotInMs: Math.max(0, Math.ceil(nextSlotAt - now)),
    // A provider cap counts every paced send in providerInFlight; model-only caps keep
    // providerInFlight at zero, so report the per-model sum for those providers instead.
    ...(anyConcurrencyCap ? {
      inFlight: providerConcurrencyCap > 0
        ? state?.providerInFlight ?? 0
        : [...(state?.modelInFlight.values() ?? [])].reduce((sum, count) => sum + count, 0),
    } : {}),
    ...(state?.lastStartedAt !== undefined ? { lastStartedAt: state.lastStartedAt } : {}),
    ...(state?.lastModelId ? { lastModelId: state.lastModelId } : {}),
  };
}

export function setProviderRequestPacingLimitsForTest(limits: {
  maxQueueDepth?: number;
  maxQueueAgeMs?: number;
}): void {
  if (limits.maxQueueDepth !== undefined) maxQueueDepth = limits.maxQueueDepth;
  if (limits.maxQueueAgeMs !== undefined) maxQueueAgeMs = limits.maxQueueAgeMs;
}

export function setProviderRequestPacingRuntimeForTest(nextRuntime: RequestPacingRuntime): void {
  runtime = nextRuntime;
}

export function reconcileProviderRequestPacing(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const [providerName, state] of pacers) {
    if (context.providerNames.has(providerName)) continue;
    removeProviderPacer(providerName, state);
    removed += 1;
  }
  lastReconciledGeneration = context.generation;
  return removed;
}

export function resetProviderRequestPacingForTest(): void {
  for (const state of pacers.values()) if (state.timer) runtime.clearTimer(state.timer);
  pacers.clear();
  maxQueueDepth = REQUEST_PACING_MAX_QUEUE_DEPTH;
  maxQueueAgeMs = REQUEST_PACING_MAX_QUEUE_AGE_MS;
  runtime = defaultRuntime;
  lastReconciledGeneration = 0;
}
