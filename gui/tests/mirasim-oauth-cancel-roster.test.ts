import { describe, expect, test } from "bun:test";
import { reconcileCancelledOAuthProvider } from "../src/pages/use-providers-oauth";
import type { OAuthAccount } from "../src/pages/providers-shared";

type AccountSet = { activeAccountId: string | null; accounts: OAuthAccount[] };

describe("Mirasim OAuth cancellation roster reconciliation", () => {
  test("clears a stale row immediately and keeps the backend empty roster authoritative", async () => {
    let state: Record<string, AccountSet> = {
      mirasim: {
        activeAccountId: "ghost",
        accounts: [{ id: "ghost", email: "masked@example.com", active: true }],
      },
    };
    const setState = (next: Record<string, AccountSet> | ((current: Record<string, AccountSet>) => Record<string, AccountSet>)) => {
      state = typeof next === "function" ? next(state) : next;
    };
    const calls: string[] = [];

    await reconcileCancelledOAuthProvider(
      "mirasim",
      setState,
      async providers => {
        calls.push(`accounts:${providers.join(",")}`);
        state = {
          ...state,
          mirasim: { activeAccountId: null, accounts: [] },
        };
        return true;
      },
      async () => { calls.push("oauth"); },
    );

    expect(state.mirasim).toEqual({ activeAccountId: null, accounts: [] });
    expect(calls).toEqual(["accounts:mirasim", "oauth"]);
  });

  test("authoritative roster can repopulate a credential that committed before cancel won the race", async () => {
    let state: Record<string, AccountSet> = {
      mirasim: {
        activeAccountId: "ghost",
        accounts: [{ id: "ghost", active: true }],
      },
    };
    const setState = (next: Record<string, AccountSet> | ((current: Record<string, AccountSet>) => Record<string, AccountSet>)) => {
      state = typeof next === "function" ? next(state) : next;
    };

    await reconcileCancelledOAuthProvider(
      "mirasim",
      setState,
      async () => {
        state = {
          ...state,
          mirasim: {
            activeAccountId: "committed",
            accounts: [{ id: "committed", active: true }],
          },
        };
        return true;
      },
      async () => {},
    );

    expect(state.mirasim.accounts.map(account => account.id)).toEqual(["committed"]);
    expect(state.mirasim.activeAccountId).toBe("committed");
  });
});
