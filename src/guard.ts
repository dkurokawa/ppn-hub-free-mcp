/**
 * Abuse guards for the keyless free tier.
 *
 * Layers (the Cloudflare-native per-minute limiter is configured in
 * wrangler.toml and checked in index.ts before any of these run):
 *
 *   1. temp ban list            KV `free-ban:<ipHash>` (TTL 24h)
 *   2. per-IP daily unit budget KV `free-day:<ipHash>:<day>` (default 100/day)
 *   3. global daily unit budget KV `free-global:<day>` (default 5000/day) —
 *      the last-resort cap against IP-rotation abuse. Exhaustion fails CLOSED.
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

export const DEFAULT_IP_DAY_LIMIT = 100;
export const DEFAULT_GLOBAL_DAY_LIMIT = 5000;
export const ERR_BAN_THRESHOLD = 20;
export const ENUM_BAN_THRESHOLD = 30;

const DAY_COUNTER_TTL = 2 * 24 * 60 * 60; // outlives its UTC day, then expires
const ERR_TTL = 60 * 60;
const ENUM_TTL = 10 * 60;
const BAN_TTL = 24 * 60 * 60;

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

export async function isBanned(kv: KvLike, ipHash: string): Promise<boolean> {
  try {
    return (await kv.get(`free-ban:${ipHash}`)) !== null;
  } catch {
    return false; // KV outage: fail open
  }
}

export interface BudgetLimits {
  ipDay: number;
  globalDay: number;
}

export interface BudgetResult {
  allowed: boolean;
  /** Which cap rejected the request (only set when allowed === false). */
  scope?: 'ip' | 'global';
}

/**
 * Charge `units` against the per-IP and global daily budgets.
 * Rejects (without charging) when either cap would be exceeded.
 */
export async function consumeBudget(
  kv: KvLike,
  ipHash: string,
  units: number,
  now: Date,
  limits: BudgetLimits = { ipDay: DEFAULT_IP_DAY_LIMIT, globalDay: DEFAULT_GLOBAL_DAY_LIMIT },
): Promise<BudgetResult> {
  if (units <= 0) return { allowed: true };
  const day = dayStamp(now);
  const ipKey = `free-day:${ipHash}:${day}`;
  const globalKey = `free-global:${day}`;
  let ipUsed: number;
  let globalUsed: number;
  try {
    [ipUsed, globalUsed] = (await Promise.all([kv.get(ipKey), kv.get(globalKey)])).map(parseCount) as [
      number,
      number,
    ];
  } catch {
    return { allowed: true }; // KV outage: fail open
  }
  if (ipUsed + units > limits.ipDay) return { allowed: false, scope: 'ip' };
  if (globalUsed + units > limits.globalDay) return { allowed: false, scope: 'global' };
  try {
    await Promise.all([
      kv.put(ipKey, String(ipUsed + units), { expirationTtl: DAY_COUNTER_TTL }),
      kv.put(globalKey, String(globalUsed + units), { expirationTtl: DAY_COUNTER_TTL }),
    ]);
  } catch {
    // Charge failed — still allow; the request was within budget.
  }
  return { allowed: true };
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
