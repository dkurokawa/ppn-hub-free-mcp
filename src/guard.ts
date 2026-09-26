/**
 * Abuse guards for the keyless free tier.
 *
 * Layers (the Cloudflare-native per-minute limiter is configured in
 * wrangler.toml and checked in index.ts before any of these run):
 *
 *   1. temp ban list            KV `free-ban:<ipHash>` (TTL 24h)
 *   2. per-IP daily unit budget KV `free-day:<ipHash>:<day>` (default 100/day)
 *      — best-effort: KV read-modify-write is not atomic, so concurrent
 *      requests can under-count (see below).
 *   3. global daily unit budget the `GlobalBudget` Durable Object
 *      (src/global-budget.ts), single instance named "global" — the
 *      last-resort cap against IP-rotation abuse. DO fetch()s to one
 *      instance are serialized by Cloudflare, so this cap is EXACT, not an
 *      approximation. Exhaustion fails CLOSED.
 *
 * index.ts calls these in order: checkIpBudget() (read-only) → if that
 * passes, consumeGlobalBudget() (charges the DO) → if that also allows,
 * chargeIpBudget() (writes the KV counter). A request whose global charge is
 * rejected never touches the per-IP counter, so the two never drift out of
 * sync from a rejected call. On a failed upstream call, index.ts refunds
 * both sides via refundIpBudget() / refundGlobalBudget().
 *
 * Abuse signals feeding the ban list:
 *   - denied / unknown operations: KV `free-err:<ipHash>` (TTL 1h, ban at >= 20)
 *   - endpoint enumeration sweeps: KV `free-enum:<ipHash>` (TTL 10 min,
 *     ban at >= 30 distinct APIs touched inside the window)
 *
 * Client IPs never reach KV in the clear: keys use
 * sha256(ip + IP_HASH_SALT) truncated to 16 hex chars.
 *
 * KV read-modify-write is not atomic; concurrent requests can under-count.
 * That is acceptable for coarse abuse limits — the per-minute Cloudflare
 * limiter bounds how far a racing client can stretch a window. Counter TTLs
 * are refreshed on every write, so the error/enum windows are sliding
 * approximations rather than exact tumbling windows. KV outages fail OPEN
 * (the minute limiter still applies); only budget exhaustion fails closed.
 */

/** Minimal KV surface used by the guards (subset of KVNamespace). */
export interface KvLike {
  get(key: string, options?: unknown): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Minimal Durable Object namespace surface used to reach GlobalBudget (subset of DurableObjectNamespace). */
export interface GlobalBudgetNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init: RequestInit): Promise<Response> };
}

export const DEFAULT_IP_DAY_LIMIT = 100;
export const DEFAULT_GLOBAL_DAY_LIMIT = 5000;
export const ERR_BAN_THRESHOLD = 20;
export const ENUM_BAN_THRESHOLD = 30;

const DAY_COUNTER_TTL = 2 * 24 * 60 * 60; // outlives its UTC day, then expires
const ERR_TTL = 60 * 60;
const ENUM_TTL = 10 * 60;
const BAN_TTL = 24 * 60 * 60;

/** Name of the single GlobalBudget Durable Object instance backing the whole Worker. */
const GLOBAL_BUDGET_INSTANCE_NAME = 'global';

/** sha256(ip + salt), truncated to 16 hex chars — the only IP form stored. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + salt));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/** UTC day stamp (YYYYMMDD) used to partition the daily counters. */
export function dayStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

function parseCount(raw: string | null): number {
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function ipDayKey(ipHash: string, day: string): string {
  return `free-day:${ipHash}:${day}`;
}

export async function isBanned(kv: KvLike, ipHash: string): Promise<boolean> {
  try {
    return (await kv.get(`free-ban:${ipHash}`)) !== null;
  } catch {
    return false; // KV outage: fail open
  }
}

export interface IpBudgetCheck {
  allowed: boolean;
}

/**
 * Read-only check: would charging `units` push the per-IP daily counter over
 * `ipDayLimit`? Does not write — call chargeIpBudget() only after the global
 * Durable Object has also allowed the request, so a global rejection never
 * leaves the per-IP counter charged for nothing.
 */
export async function checkIpBudget(
  kv: KvLike,
  ipHash: string,
  units: number,
  now: Date,
  ipDayLimit: number = DEFAULT_IP_DAY_LIMIT,
): Promise<IpBudgetCheck> {
  if (units <= 0) return { allowed: true };
  try {
    const used = parseCount(await kv.get(ipDayKey(ipHash, dayStamp(now))));
    return { allowed: used + units <= ipDayLimit };
  } catch {
    return { allowed: true }; // KV outage: fail open
  }
}

/** Charge `units` against the per-IP daily counter. Best effort (see module doc). */
export async function chargeIpBudget(kv: KvLike, ipHash: string, units: number, now: Date): Promise<void> {
  if (units <= 0) return;
  try {
    const key = ipDayKey(ipHash, dayStamp(now));
    const used = parseCount(await kv.get(key));
    await kv.put(key, String(used + units), { expirationTtl: DAY_COUNTER_TTL });
  } catch {
    // best effort
  }
}

/** Give back `units` previously charged to the per-IP daily counter (upstream failure). */
export async function refundIpBudget(kv: KvLike, ipHash: string, units: number, now: Date): Promise<void> {
  if (units <= 0) return;
  try {
    const key = ipDayKey(ipHash, dayStamp(now));
    const used = parseCount(await kv.get(key));
    await kv.put(key, String(Math.max(0, used - units)), { expirationTtl: DAY_COUNTER_TTL });
  } catch {
    // best effort
  }
}

export interface GlobalBudgetResult {
  allowed: boolean;
}

/**
 * Charge `units` against the shared global daily budget via the GlobalBudget
 * Durable Object. The DO serializes this check-then-write, so — unlike the
 * per-IP KV counters — this is exact: no two concurrent calls can both
 * squeeze through past `globalDayLimit`.
 */
export async function consumeGlobalBudget(
  ns: GlobalBudgetNamespaceLike,
  now: Date,
  units: number,
  globalDayLimit: number = DEFAULT_GLOBAL_DAY_LIMIT,
): Promise<GlobalBudgetResult> {
  if (units <= 0) return { allowed: true };
  const stub = ns.get(ns.idFromName(GLOBAL_BUDGET_INSTANCE_NAME));
  const res = await stub.fetch('https://global-budget.internal/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ day: dayStamp(now), units, limit: globalDayLimit }),
  });
  const body = await res.json<{ allowed: boolean }>();
  return { allowed: body.allowed };
}

/** Give back `units` previously charged to the global daily budget (upstream failure). */
export async function refundGlobalBudget(ns: GlobalBudgetNamespaceLike, now: Date, units: number): Promise<void> {
  if (units <= 0) return;
  const stub = ns.get(ns.idFromName(GLOBAL_BUDGET_INSTANCE_NAME));
  await stub.fetch('https://global-budget.internal/refund', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ day: dayStamp(now), units }),
  });
}

/**
 * Record a denied/unknown operation. Crossing ERR_BAN_THRESHOLD inside the
 * (sliding) 1h window puts the client on the 24h ban list.
 */
export async function recordDenied(kv: KvLike, ipHash: string): Promise<void> {
  try {
    const key = `free-err:${ipHash}`;
    const n = parseCount(await kv.get(key)) + 1;
    await kv.put(key, String(n), { expirationTtl: ERR_TTL });
    if (n >= ERR_BAN_THRESHOLD) {
      await kv.put(`free-ban:${ipHash}`, '1', { expirationTtl: BAN_TTL });
    }
  } catch {
    // best effort
  }
}

/**
 * Track how many DISTINCT APIs a client has touched via execute_api inside a
 * 10-minute window. A wide spread is an enumeration sweep, not organic use —
 * crossing ENUM_BAN_THRESHOLD puts the client on the 24h ban list.
 */
export async function recordApiSpread(kv: KvLike, ipHash: string, apis: string[]): Promise<void> {
  if (apis.length === 0) return;
  try {
    const key = `free-enum:${ipHash}`;
    const seen = new Set<string>();
    const raw = await kv.get(key);
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) for (const a of parsed) if (typeof a === 'string') seen.add(a);
      } catch {
        // corrupted counter — start over
      }
    }
    for (const a of apis) seen.add(a);
    await kv.put(key, JSON.stringify([...seen].sort()), { expirationTtl: ENUM_TTL });
    if (seen.size >= ENUM_BAN_THRESHOLD) {
      await kv.put(`free-ban:${ipHash}`, '1', { expirationTtl: BAN_TTL });
    }
  } catch {
    // best effort
  }
}
