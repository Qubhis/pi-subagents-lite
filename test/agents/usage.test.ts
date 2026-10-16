/**
 * usage.test.ts — Tests for usage tracking utilities.
 */

import { describe, it, expect } from "vitest";
import {
  type LifetimeUsage,
  type SessionLike,
  addUsage,
  getLifetimeTotal,
  formatTokens,
  formatCost,
  getSessionContextInfo,
  getSessionContextPercent,
  resolveContextInfo,
  formatContextSummary,
} from "../../src/agents/usage.js";

/** Minimal SessionLike whose getSessionStats returns the given contextUsage. */
function sessionWith(contextUsage: unknown): SessionLike {
  return {
    getSessionStats: () =>
      ({
        tokens: { input: 0, output: 0, cacheWrite: 0 },
        contextUsage,
      }) as ReturnType<SessionLike["getSessionStats"]>,
  };
}

/* ------------------------------------------------------------------ */
/*  addUsage — cost accumulation                                       */
/* ------------------------------------------------------------------ */

describe("addUsage", () => {
  it("accumulates cost into target", () => {
    const target: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    addUsage(target, { input: 10, output: 5, cacheWrite: 1, cost: 2 });
    expect(target).toEqual({ input: 110, output: 55, cacheWrite: 11, cost: 7 });
  });

  it("handles zero cost delta", () => {
    const target: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    addUsage(target, { input: 10, output: 5, cacheWrite: 1, cost: 0 });
    expect(target.cost).toBe(5);
  });

  it("accumulates multiple deltas", () => {
    const target: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cost: 0 };
    addUsage(target, { input: 100, output: 50, cacheWrite: 10, cost: 2.5 });
    addUsage(target, { input: 200, output: 100, cacheWrite: 20, cost: 5.0 });
    addUsage(target, { input: 50, output: 25, cacheWrite: 5, cost: 1.25 });
    expect(target).toEqual({ input: 350, output: 175, cacheWrite: 35, cost: 8.75 });
  });
});

/* ------------------------------------------------------------------ */
/*  getLifetimeTotal — returns input + output only                        */
/* ------------------------------------------------------------------ */

describe("getLifetimeTotal", () => {
  it("returns sum of input + output only (no cacheWrite, no cost)", () => {
    const u: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    // 100 + 50 = 150
    expect(getLifetimeTotal(u)).toBe(150);
  });

  it("returns 0 for undefined", () => {
    expect(getLifetimeTotal(undefined)).toBe(0);
  });

  it("returns 0 when input and output are 0", () => {
    const u: LifetimeUsage = { input: 0, output: 0, cacheWrite: 99, cost: 99 };
    expect(getLifetimeTotal(u)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  formatTokens — compact token formatting                            */
/* ------------------------------------------------------------------ */

describe("formatTokens", () => {
  it("formats values below 1000 as raw number", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats values >= 1000 with k suffix (1 decimal)", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(12300)).toBe("12.3k");
    expect(formatTokens(100500)).toBe("100.5k");
  });

  it("formats values >= 1000000 with M suffix (1 decimal)", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(12_345_678)).toBe("12.3M");
  });

  it("rounds down (no decimal rounding issues)", () => {
    // 1234 → 1.234 → 1.2k
    expect(formatTokens(1234)).toBe("1.2k");
  });
  it("compact mode rounds thousands to whole k", () => {
    expect(formatTokens(999, true)).toBe("999");
    expect(formatTokens(12300, true)).toBe("12k");
    expect(formatTokens(12500, true)).toBe("13k");
  });

  it("compact mode leaves the M range at 1 decimal", () => {
    expect(formatTokens(1_200_000, true)).toBe("1.2M");
  });

  it("handles exactly 1 million", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });
});

/* ------------------------------------------------------------------ */
/*  formatCost — dollar formatting                                   */
/* ------------------------------------------------------------------ */

describe("formatCost", () => {
  it("formats zero as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats small cost with 2 decimal places", () => {
    expect(formatCost(0.008)).toBe("$0.01");
  });

  it("formats $1.23", () => {
    expect(formatCost(1.23)).toBe("$1.23");
  });

  it("formats $0.01", () => {
    expect(formatCost(0.01)).toBe("$0.01");
  });

  it("formats $12.34", () => {
    expect(formatCost(12.345)).toBe("$12.35");
  });

  it("formats very small cost as $0.00", () => {
    expect(formatCost(0.001)).toBe("$0.00");
  });
});

/* ------------------------------------------------------------------ */
/*  getSessionContextInfo / getSessionContextPercent                   */
/* ------------------------------------------------------------------ */

describe("getSessionContextInfo", () => {
  it("reads tokens, contextWindow, and percent from the session", () => {
    const session = sessionWith({ tokens: 60000, contextWindow: 200000, percent: 30 });
    expect(getSessionContextInfo(session)).toEqual({ tokens: 60000, contextWindow: 200000, percent: 30 });
  });

  it("returns all-null when the session is undefined", () => {
    expect(getSessionContextInfo(undefined)).toEqual({ tokens: null, contextWindow: null, percent: null });
  });

  it("returns all-null when contextUsage is absent (e.g. post-compaction)", () => {
    expect(getSessionContextInfo(sessionWith(undefined))).toEqual({
      tokens: null,
      contextWindow: null,
      percent: null,
    });
  });

  it("maps missing individual fields to null", () => {
    const session = sessionWith({ percent: 42 });
    expect(getSessionContextInfo(session)).toEqual({ tokens: null, contextWindow: null, percent: 42 });
  });

  it("returns all-null when getSessionStats throws", () => {
    const session: SessionLike = {
      getSessionStats: () => {
        throw new Error("boom");
      },
    };
    expect(getSessionContextInfo(session)).toEqual({ tokens: null, contextWindow: null, percent: null });
  });

  it("getSessionContextPercent projects just the percent", () => {
    expect(getSessionContextPercent(sessionWith({ tokens: 10, contextWindow: 20, percent: 50 }))).toBe(50);
    expect(getSessionContextPercent(undefined)).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/*  resolveContextInfo — live first, else stored (retro analysis)      */
/* ------------------------------------------------------------------ */

describe("resolveContextInfo", () => {
  it("prefers live session values over stored ones", () => {
    const session = sessionWith({ tokens: 60000, contextWindow: 200000, percent: 30 });
    const stored = { contextTokens: 1, contextWindow: 2, contextPercent: 3 };
    expect(resolveContextInfo(session, stored)).toEqual({ tokens: 60000, contextWindow: 200000, percent: 30 });
  });

  it("falls back to stored values for a settled agent (no live session)", () => {
    const stored = { contextTokens: 125000, contextWindow: 200000, contextPercent: 63 };
    expect(resolveContextInfo(undefined, stored)).toEqual({ tokens: 125000, contextWindow: 200000, percent: 63 });
  });

  it("returns all-null when neither live nor stored values exist", () => {
    expect(resolveContextInfo(undefined, {})).toEqual({ tokens: null, contextWindow: null, percent: null });
  });
});

/* ------------------------------------------------------------------ */
/*  formatContextSummary — compact one-liner                           */
/* ------------------------------------------------------------------ */

describe("formatContextSummary", () => {
  it("shows tokens/window and percent", () => {
    expect(formatContextSummary({ tokens: 73000, contextWindow: 200000, percent: 37 })).toBe("73k/200k ctx 37%");
  });

  it("omits the window when it is unknown", () => {
    expect(formatContextSummary({ tokens: 73000, contextWindow: null, percent: 37 })).toBe("73k ctx 37%");
  });

  it("shows just the percent when tokens are unknown", () => {
    expect(formatContextSummary({ tokens: null, contextWindow: null, percent: 37 })).toBe("37%");
  });

  it("returns null when nothing is available", () => {
    expect(formatContextSummary({ tokens: null, contextWindow: null, percent: null })).toBe(null);
  });
});
