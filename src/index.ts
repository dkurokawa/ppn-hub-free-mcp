/**
 * ppn-hub-free-mcp — keyless read-only MCP entry point for PPN Hub.
 *
 * A thin proxy in front of the main gateway (mcp.ppn-hub.com/mcp):
 *   - initialize / ping / tools/list / search_apis pass through anonymously
 *     (tools/list descriptions are rewritten with the free-tier rules),
 *   - execute_api runs WITHOUT a key for allowlisted GET read endpoints —
 *     the proxy injects a dedicated free-tier ppn_live_* backend key,
 *   - everything else is rejected: malformed / batched / off-allow-list
 *     methods with a JSON-RPC protocol error, disallowed tool calls with a
 *     tool-style error pointing at the quickstart,
 *   - per-IP minute + daily budgets (approximate, KV), a global daily budget
 *     (exact, Durable Object), and an abuse ban list keep the keyless
 *     surface bounded (see src/guard.ts, src/global-budget.ts).
 *
 * Inbound Authorization headers are intentionally STRIPPED: this endpoint is
 * anonymous-only. Key holders should call mcp.ppn-hub.com/mcp directly.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { isAllowed, allowlistMeta } from './allowlist.js';
import {
  hashIp,
  isBanned,
  checkIpBudget,
  chargeIpBudget,
  refundIpBudget,
  consumeGlobalBudget,
  refundGlobalBudget,
  recordDenied,
  recordApiSpread,
  DEFAULT_IP_DAY_LIMIT,
  DEFAULT_GLOBAL_DAY_LIMIT,
  type KvLike,
  type GlobalBudgetNamespaceLike,
} from './guard.js';
import { inspectRpc, denyBody, patchToolsListText, QUICKSTART_URL, UPSTREAM_HINT } from './rpc.js';

export { GlobalBudget } from './global-budget.js';

/** Cloudflare-native rate limiter binding (GA `[[ratelimits]]`). */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  FREE_KV?: KVNamespace;
  IP_RATE_LIMITER?: RateLimiter;
  /** Enforces the shared global daily budget exactly (see src/global-budget.ts). */
  GLOBAL_BUDGET?: DurableObjectNamespace;
  /** Dedicated free-tier ppn_live_* key (never a service/admin key). */
  FREE_TIER_BACKEND_KEY?: string;
  /** Random salt so client IPs never reach KV in the clear. */
  IP_HASH_SALT?: string;
  UPSTREAM_MCP_URL?: string;
  FREE_IP_DAY_LIMIT?: string;
  FREE_GLOBAL_DAY_LIMIT?: string;
}

export const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});

app.get('/', (c) =>
  c.json({
    success: true,
    data: {
      name: 'PPN Hub Free MCP',
      description:
        'Keyless read-only MCP entry point for PPN Hub. Allowlisted GET endpoints run ' +
        'without a key; get a free ppn_live_* key for the full surface.',
      endpoint: '/mcp',
      transport: 'streamable-http',
      tools: ['search_apis', 'execute_api', 'environment_brief'],
      allowlist: allowlistMeta(),
      limits: {
        per_ip_minute: 10,
        per_ip_day_units: intVar(c.env.FREE_IP_DAY_LIMIT, DEFAULT_IP_DAY_LIMIT),
        global_day_units: intVar(c.env.FREE_GLOBAL_DAY_LIMIT, DEFAULT_GLOBAL_DAY_LIMIT),
        environment_brief_cost_units: 10,
      },
      full_surface: UPSTREAM_HINT,
      get_a_key: QUICKSTART_URL,
      source: 'https://github.com/dkurokawa/ppn-hub-free-mcp',
    },
  }),
);

app.get('/health', (c) => c.json({ success: true, data: { status: 'healthy' } }));

function intVar(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function tooMany(c: Context, message: string, retryAfterSeconds?: number) {
  if (retryAfterSeconds !== undefined) c.header('Retry-After', String(retryAfterSeconds));
  return c.json(
    { success: false, error: { code: 'RATE_LIMITED', message, status: 429 } },
    429,
  );
}

/** Refund units charged for a request whose upstream call failed. Fire-and-forget. */
async function refundUnits(
  kv: KvLike | undefined,
  globalBudget: GlobalBudgetNamespaceLike | undefined,
  ipHash: string,
  units: number,
  now: Date,
): Promise<void> {
  await Promise.all([
    kv ? refundIpBudget(kv, ipHash, units, now) : Promise.resolve(),
    globalBudget ? refundGlobalBudget(globalBudget, now, units) : Promise.resolve(),
  ]);
}

app.post('/mcp', async (c) => {
  const env = c.env;
  const kv = env.FREE_KV as KvLike | undefined;
  const globalBudget = env.GLOBAL_BUDGET as GlobalBudgetNamespaceLike | undefined;

  // ── Fail closed if KV-backed guards are enabled but can't hash IPs safely ──
  if (kv && !env.IP_HASH_SALT) {
    return c.json(
      {
        success: false,
        error: {
          code: 'FREE_TIER_MISCONFIGURED',
          message: 'The free tier is temporarily misconfigured. Try again later, or use a free ' +
            `ppn_live_* key against ${UPSTREAM_HINT}: ${QUICKSTART_URL}`,
          status: 503,
        },
      },
      503,
    );
  }

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipHash = kv && env.IP_HASH_SALT ? await hashIp(ip, env.IP_HASH_SALT) : '';

  // ── Layer 0: temp ban list ──
  if (kv && (await isBanned(kv, ipHash))) {
    return tooMany(
      c,
      `This client is temporarily blocked for abusive traffic patterns. The block expires ` +
        `automatically. For unrestricted access get a free ppn_live_* key: ${QUICKSTART_URL}`,
    );
  }

  // ── Layer 1: per-IP burst limit (Cloudflare-native, absent in local dev → open) ──
  if (env.IP_RATE_LIMITER) {
    try {
      const { success } = await env.IP_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return tooMany(
          c,
          `Free tier limit: 10 requests/min per IP. Retry shortly, or get a free ppn_live_* ` +
            `key for higher limits: ${QUICKSTART_URL}`,
          60,
        );
      }
    } catch {
      // limiter outage: fail open (daily budgets still apply)
    }
  }

  // ── JSON-RPC inspection (protocol-level: batches / unknown methods / malformed) ──
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      400,
    );
  }
  const decision = inspectRpc(payload, isAllowed);

  if (decision.kind === 'protocol-error') {
    return c.json(decision.body, decision.status);
  }

  if (decision.kind === 'deny') {
    if (kv) {
      c.executionCtx.waitUntil(recordDenied(kv, ipHash));
      if (decision.apisTouched.length > 0) {
        c.executionCtx.waitUntil(recordApiSpread(kv, ipHash, decision.apisTouched));
      }
    }
    return c.json(denyBody(decision.id, decision.message));
  }

  // ── Layer 2+3: daily budgets — per-IP (KV, approximate) checked first, then
  //    the global cap (Durable Object, exact, fail-closed). Only once both
  //    agree is the per-IP counter actually charged (see guard.ts). ──
  const now = new Date();
  let chargedUnits = 0;
  if (kv && decision.units > 0) {
    const ipDayLimit = intVar(env.FREE_IP_DAY_LIMIT, DEFAULT_IP_DAY_LIMIT);
    const ipCheck = await checkIpBudget(kv, ipHash, decision.units, now, ipDayLimit);
    if (!ipCheck.allowed) {
      return tooMany(
        c,
        `Free tier daily budget exhausted for this IP (resets at 00:00 UTC). Get a free ` +
          `ppn_live_* key for higher limits: ${QUICKSTART_URL}`,
      );
    }

    if (globalBudget) {
      const globalDayLimit = intVar(env.FREE_GLOBAL_DAY_LIMIT, DEFAULT_GLOBAL_DAY_LIMIT);
      const globalCheck = await consumeGlobalBudget(globalBudget, now, decision.units, globalDayLimit);
      if (!globalCheck.allowed) {
        return tooMany(
          c,
          `The shared free tier is fully used for today (resets at 00:00 UTC). Get a free ` +
            `ppn_live_* key for uninterrupted access: ${QUICKSTART_URL}`,
        );
      }
    }

    await chargeIpBudget(kv, ipHash, decision.units, now);
    chargedUnits = decision.units;
  }
  if (kv && decision.apisTouched.length > 0) {
    c.executionCtx.waitUntil(recordApiSpread(kv, ipHash, decision.apisTouched));
  }

  // ── Forward upstream ──
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: c.req.header('Accept') ?? 'application/json, text/event-stream',
  };
  const protocolVersion = c.req.header('MCP-Protocol-Version');
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  if (decision.needsKey) {
    if (!env.FREE_TIER_BACKEND_KEY) {
      return c.json(
        {
          success: false,
          error: {
            code: 'FREE_TIER_UNAVAILABLE',
            message: `The free execution tier is temporarily unavailable. Use a free ppn_live_* key against ${UPSTREAM_HINT}: ${QUICKSTART_URL}`,
            status: 503,
          },
        },
        503,
      );
    }
    headers.authorization = `Bearer ${env.FREE_TIER_BACKEND_KEY}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(env.UPSTREAM_MCP_URL ?? UPSTREAM_HINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch {
    if (chargedUnits > 0) {
      c.executionCtx.waitUntil(refundUnits(kv, globalBudget, ipHash, chargedUnits, now));
    }
    return c.json(
      {
        success: false,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The upstream gateway is unreachable.', status: 502 },
      },
      502,
    );
  }

  if (upstream.status >= 500 && chargedUnits > 0) {
    c.executionCtx.waitUntil(refundUnits(kv, globalBudget, ipHash, chargedUnits, now));
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  if (decision.patchToolsList && upstream.ok) {
    const text = await upstream.text();
    return new Response(patchToolsListText(text, contentType), {
      status: upstream.status,
      headers: { 'content-type': contentType },
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': contentType },
  });
});

// Streamable HTTP GET/DELETE (session streams) are not offered on the free
// tier — the upstream transport is stateless anyway.
app.all('/mcp', (c) =>
  c.json(
    {
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for MCP JSON-RPC.', status: 405 },
    },
    405,
  ),
);

export default app;
