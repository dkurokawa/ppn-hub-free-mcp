/**
 * ppn-hub-free-mcp — keyless read-only MCP entry point for PPN Hub.
 *
 * A thin proxy in front of the main gateway (mcp.ppn-hub.com/mcp):
 *   - initialize / tools/list / search_apis pass through anonymously
 *     (tools/list descriptions are rewritten with the free-tier rules),
 *   - execute_api runs WITHOUT a key for allowlisted GET read endpoints —
 *     the proxy injects a dedicated free-tier ppn_live_* backend key,
 *   - everything else is rejected with a pointer to the quickstart,
 *   - per-IP minute + daily budgets, a global daily budget, and an abuse
 *     ban list keep the keyless surface bounded (see src/guard.ts).
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
  consumeBudget,
  recordDenied,
  recordApiSpread,
  DEFAULT_IP_DAY_LIMIT,
  DEFAULT_GLOBAL_DAY_LIMIT,
  type KvLike,
} from './guard.js';
import { inspectRpc, denyBody, patchToolsListText, QUICKSTART_URL, UPSTREAM_HINT } from './rpc.js';

/** Cloudflare-native rate limiter binding (GA `[[ratelimits]]`). */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type Env = {
  FREE_KV?: KVNamespace;
  IP_RATE_LIMITER?: RateLimiter;
  /** Dedicated free-tier ppn_live_* key (never a service/admin key). */
  FREE_TIER_BACKEND_KEY?: string;
  /** Random salt so client IPs never reach KV in the clear. */
  IP_HASH_SALT?: string;
  UPSTREAM_MCP_URL?: string;
  FREE_IP_DAY_LIMIT?: string;
  FREE_GLOBAL_DAY_LIMIT?: string;
};

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

app.post('/mcp', async (c) => {
  const env = c.env;
  const kv = env.FREE_KV as KvLike | undefined;
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipHash = kv ? await hashIp(ip, env.IP_HASH_SALT ?? 'unsalted-dev') : '';

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

  // ── JSON-RPC inspection (read-only allowlist, batches included) ──
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

  if (decision.kind === 'deny') {
    if (kv) {
      c.executionCtx.waitUntil(recordDenied(kv, ipHash));
      if (decision.apisTouched.length > 0) {
        c.executionCtx.waitUntil(recordApiSpread(kv, ipHash, decision.apisTouched));
      }
    }
    return c.json(denyBody(decision.id, decision.message));
  }

  // ── Layer 2+3: daily budgets (per-IP, then global fail-closed) ──
  if (kv && decision.units > 0) {
    const budget = await consumeBudget(kv, ipHash, decision.units, new Date(), {
      ipDay: intVar(env.FREE_IP_DAY_LIMIT, DEFAULT_IP_DAY_LIMIT),
      globalDay: intVar(env.FREE_GLOBAL_DAY_LIMIT, DEFAULT_GLOBAL_DAY_LIMIT),
    });
    if (!budget.allowed) {
      const message =
        budget.scope === 'ip'
          ? `Free tier daily budget exhausted for this IP (resets at 00:00 UTC). Get a free ` +
            `ppn_live_* key for higher limits: ${QUICKSTART_URL}`
          : `The shared free tier is fully used for today (resets at 00:00 UTC). Get a free ` +
            `ppn_live_* key for uninterrupted access: ${QUICKSTART_URL}`;
      return tooMany(c, message);
    }
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
    headers['authorization'] = `Bearer ${env.FREE_TIER_BACKEND_KEY}`;
  }

  const upstream = await fetch(env.UPSTREAM_MCP_URL ?? UPSTREAM_HINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

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
