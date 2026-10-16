/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times. See issue #38.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cost: number };

/**
 * A single per-turn usage event as emitted upstream. Adds `cacheRead`, which
 * LifetimeUsage omits from totals (see issue #38).
 */
export type AgentUsage = LifetimeUsage & { cacheRead: number };

/** Sum of input + output token counts, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  into.cost += delta.cost;
}

/** Minimal shape we read from upstream `getSessionStats()`. */
type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/** Format a token count compactly: "12.3k", "1.2M", or raw number. When compact is true, thousands round to whole numbers. */
export function formatTokens(count: number, compact = false): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return compact ? `${Math.round(count / 1_000)}k` : `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

/** Format cost as a dollar amount: "$0.00", "$0.01", "$1.23". */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/**
 * Context-window snapshot: current token occupancy, the model's context-window
 * size, and utilization percent. Each field is null when unavailable (no
 * session, no model contextWindow, or post-compaction before the next response).
 */
export type ContextInfo = { tokens: number | null; contextWindow: number | null; percent: number | null };

const EMPTY_CONTEXT_INFO: ContextInfo = { tokens: null, contextWindow: null, percent: null };

/** Live context-window snapshot read from the session, or an all-null snapshot when unavailable. */
export function getSessionContextInfo(session: SessionLike | undefined): ContextInfo {
  if (!session) return EMPTY_CONTEXT_INFO;
  try {
    const usage = session.getSessionStats().contextUsage;
    return {
      tokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      percent: usage?.percent ?? null,
    };
  } catch {
    return EMPTY_CONTEXT_INFO;
  }
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  return getSessionContextInfo(session).percent;
}

/** Context fields captured on a record's stats at settlement, for settled-agent (retro) reads. */
export type StoredContext = {
  contextTokens?: number | null;
  contextWindow?: number | null;
  contextPercent?: number | null;
};

/**
 * Effective context snapshot: the live session value when present, else the
 * value stored on the record at settlement. Lets both running agents (live)
 * and ended agents (retro analysis) report tokens, window, and percent.
 */
export function resolveContextInfo(session: SessionLike | undefined, stored: StoredContext): ContextInfo {
  const live = getSessionContextInfo(session);
  return {
    tokens: live.tokens ?? stored.contextTokens ?? null,
    contextWindow: live.contextWindow ?? stored.contextWindow ?? null,
    percent: live.percent ?? stored.contextPercent ?? null,
  };
}

/**
 * Compact one-line context summary, e.g. "73k/200k ctx 37%" or "73k ctx 37%",
 * or null when no context data is available. Token counts use the compact form.
 */
export function formatContextSummary(info: ContextInfo): string | null {
  const parts: string[] = [];
  if (info.tokens != null) {
    parts.push(
      info.contextWindow != null
        ? `${formatTokens(info.tokens, true)}/${formatTokens(info.contextWindow, true)} ctx`
        : `${formatTokens(info.tokens, true)} ctx`,
    );
  }
  if (info.percent != null) parts.push(`${Math.round(info.percent)}%`);
  return parts.length > 0 ? parts.join(" ") : null;
}
