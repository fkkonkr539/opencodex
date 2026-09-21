import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirasimDeviceIdentity } from "../../src/adapters/mirasim/crypto";
import { resetMirasimTransportStateForTests } from "../../src/adapters/mirasim/transport";
import { saveCredential } from "../../src/oauth/store";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { handleClaudeCountTokens } from "../../src/server/claude-messages";
import { handleSearch } from "../../src/server/search";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opencodex-mirasim-endpoints-"));
  mkdirSync(home, { recursive: true });
  process.env.OPENCODEX_HOME = home;
  resetMirasimTransportStateForTests();
});

afterEach(() => {
  resetMirasimTransportStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function syntheticCredential() {
  const identity = createMirasimDeviceIdentity();
  return {
    access: "mirasim-endpoint-access",
    refresh: "mirasim-endpoint-refresh",
    expires: Date.now() + 3_600_000,
    source: "oauth" as const,
    accountId: "mirasim-endpoint-account",
    mirasim: {
      devicePrivateKey: identity.privateKeyPem,
      relayUrl: "https://relay.mirasim.ai",
      adminUrl: "https://auth.mirasim.ai",
      clientVersion: "0.0.336",
    },
  };
}

type Captured = { path: string; method: string; headers: Headers; body?: Record<string, unknown> };

function mirasimConfig(fakeFetch: typeof fetch): OcxConfig {
  const entry = getProviderRegistryEntry("mirasim");
  if (!entry) throw new Error("missing Mirasim registry entry");
  const provider = {
    ...providerConfigSeed(entry),
    fetch: fakeFetch,
  } as OcxProviderConfig & { fetch: typeof fetch };
  return {
    port: 0,
    defaultProvider: "mirasim",
    providers: { mirasim: provider },
  } as OcxConfig;
}

function captureFetch(calls: Captured[], responder: (call: Captured) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let body: Record<string, unknown> | undefined;
    if (rawBody) {
      try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* not JSON */ }
    }
    const call: Captured = {
      path: new URL(url).pathname,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(body ? { body } : {}),
    };
    calls.push(call);
    if (call.path === "/v1/device/session") {
      return new Response(JSON.stringify({ ticket: "mirasim-endpoint-ticket", expiresIn: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return responder(call);
  }) as typeof fetch;
}

describe("Mirasim auxiliary inference endpoints", () => {
  test("non-stream GPT caller receives bounded JSON even though Mirasim forces upstream Responses SSE", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: Captured[] = [];
    const config = mirasimConfig(captureFetch(calls, call => {
      if (call.path !== "/v1/responses") return new Response("not found", { status: 404 });
      expect(call.body).toMatchObject({
        model: "gpt-5.6-luna",
        stream: true,
        store: false,
        parallel_tool_calls: true,
        include: ["reasoning.encrypted_content"],
      });
      const terminal = {
        type: "response.completed",
        response: {
          id: "resp_mirasim_fixture",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.6-luna",
          // The live relay can leave the terminal snapshot empty even after emitting authoritative
          // output_item.done frames. The non-stream collector must reconstruct output from them.
          output: [],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        },
      };
      const functionDone = {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "fc_mirasim_fixture",
          type: "function_call",
          call_id: "call_mirasim_fixture",
          name: "lookup",
          arguments: "{}",
          status: "completed",
        },
      };
      const messageDone = {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_mirasim_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        },
      };
      return new Response([
        `data: ${JSON.stringify(functionDone)}\n\n`,
        `data: ${JSON.stringify(messageDone)}\n\n`,
        `data: ${JSON.stringify(terminal)}\n\n`,
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mirasim/gpt-5.6-luna",
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with OK only." }],
          }],
          stream: false,
        }),
      }), config, { model: "", provider: "" }, { abortSignal: AbortSignal.timeout(5_000) });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const json = await response.json() as {
        id?: string;
        status?: string;
        model?: string;
        output?: Array<{
          type?: string;
          content?: Array<{ text?: string }>;
          call_id?: string;
          name?: string;
          arguments?: string;
        }>;
      };
      expect(json.id).toBe("resp_mirasim_fixture");
      expect(json.status).toBe("completed");
      expect(json.model).toBe("gpt-5.6-luna");
      expect(json.output?.[0]?.content?.[0]?.text).toBe("OK");
      expect(json.output?.[1]).toMatchObject({
        type: "function_call",
        call_id: "call_mirasim_fixture",
        name: "lookup",
        arguments: "{}",
      });
      expect(calls.map(call => call.path)).toEqual([
        "/v1/device/session",
        "/v1/responses",
      ]);
    } finally {
      releaseSpendHome();
    }
  });

  test("Claude count_tokens uses the signed relay, bare model id, and long-context beta", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: Captured[] = [];
    const config = mirasimConfig(captureFetch(calls, call => {
      if (call.path === "/v1/messages/count_tokens") {
        return new Response(JSON.stringify({ input_tokens: 321 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    const response = await handleClaudeCountTokens(new Request("http://127.0.0.1/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "other-beta",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5[1m]",
        messages: [{ role: "user", content: "count this" }],
      }),
    }), config);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 321 });
    expect(calls.map(call => call.path)).toEqual([
      "/v1/device/session",
      "/v1/messages/count_tokens",
    ]);
    const count = calls[1]!;
    expect(count.body?.model).toBe("claude-sonnet-5");
    expect(count.headers.get("authorization")).toBe("Bearer mirasim-endpoint-ticket");
    expect(count.headers.get("anthropic-beta")).toBe("other-beta,context-1m-2025-08-07");
    expect(count.headers.get("x-mirasim-enc")).toBeTruthy();
    expect(count.headers.get("x-mirasim-agent")).toBeNull();
  });

  test("alpha/search routes a Mirasim GPT model through the signed inference transport", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: Captured[] = [];
    const config = mirasimConfig(captureFetch(calls, call => {
      if (call.path === "/v1/alpha/search") {
        return new Response(JSON.stringify({ output: "mirasim search" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));
    const logCtx = {} as RequestLogContext;
    const response = await handleSearch(new Request("http://127.0.0.1/v1/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mirasim/gpt-5.6-sol",
        commands: { search_query: [{ q: "Mirasim" }] },
      }),
    }), config, logCtx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: "mirasim search" });
    expect(calls.map(call => call.path)).toEqual([
      "/v1/device/session",
      "/v1/alpha/search",
    ]);
    const search = calls[1]!;
    expect(search.body?.model).toBe("gpt-5.6-sol");
    expect(search.headers.get("authorization")).toBe("Bearer mirasim-endpoint-ticket");
    expect(search.headers.get("x-mirasim-enc")).toBeTruthy();
    expect(search.headers.get("x-mirasim-agent")).toBeNull();
    expect(logCtx.provider).toBe("mirasim");
    expect(logCtx.model).toBe("gpt-5.6-sol");
  });
});
