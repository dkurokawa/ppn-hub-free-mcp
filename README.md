# PPN Hub Free MCP

**Keyless, read-only MCP entry point for [PPN Hub](https://ppn-hub.com)** — try
75 public APIs (weather, elevation, Japanese addresses, environment, science,
civic data) from any MCP client with **zero signup**.

```
https://mcp-free.ppn-hub.com/mcp        (Streamable HTTP)
```

## What you get

| Tool                | Free tier behaviour                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| `search_apis`       | Full anonymous discovery across the public surface (484 endpoints)         |
| `execute_api`       | **Allowlisted GET read endpoints run without a key** (see `allowlist.json`) |
| `environment_brief` | Works without a key; costs 10 units of the daily budget (it fans out)      |

Everything else — POST/write operations, higher limits, the full surface — needs
a **free `ppn_live_*` key**: get one at **<https://ppn-hub.com/quickstart>** and
point your client at `https://mcp.ppn-hub.com/mcp` (one-click OAuth supported).

### Client setup (Claude Code example)

```bash
claude mcp add --transport http ppn-free https://mcp-free.ppn-hub.com/mcp
```

## Free tier limits

| Limit                    | Value                                     |
| ------------------------ | ----------------------------------------- |
| Per IP, burst            | 10 requests / minute                      |
| Per IP, daily            | 100 units / day (UTC)                     |
| Shared global cap        | 5,000 units / day — last-resort abuse cap |
| `environment_brief` cost | 10 units per call                         |

Regular requests cost 1 unit (`initialize`/`tools/list` are free). When you hit
a limit you get a `429` with a pointer to the quickstart. Abusive patterns
(operation brute-forcing, endpoint enumeration sweeps) earn a temporary 24h
block. Client IPs are stored only as salted SHA-256 hashes.

## How it works (architecture)

This repo is a **thin proxy Worker** — Hono only, ~4 small source files, no
access to any private code:

```
MCP client ──POST /mcp──▶ ppn-hub-free-mcp (this repo)
                            │  1. ban list / rate limits / daily budgets (KV)
                            │  2. JSON-RPC inspection (batches included):
                            │     GET-only allowlist, deny-by-default
                            │  3. inject a dedicated free-tier backend key
                            ▼
                          mcp.ppn-hub.com/mcp (main gateway, private repo)
```

- `src/index.ts` — routing, limit enforcement, upstream forwarding
- `src/rpc.ts` — JSON-RPC inspection + `tools/list` description rewriting
- `src/guard.ts` — KV budgets, abuse detection, ban list
- `src/allowlist.ts` + `allowlist.json` — the GET-only allowlist (deny-by-default)
- `scripts/gen-allowlist.mjs` — regenerates `allowlist.json` from the LIVE
  public surface; endpoints whose backing code bills per call (AI providers)
  are excluded there

The backend key held by this Worker is a normal free-tier consumer key — it is
**not** a service/admin credential, and the upstream gateway enforces its own
auth and quotas independently ([auth model](https://github.com/dkurokawa/ppn-mono/blob/main/docs/MCP-CLIENT-SETUP.md)).

## Develop / deploy

```bash
pnpm install
pnpm test              # vitest: guards, allowlist, JSON-RPC inspection
pnpm run typecheck
pnpm run dev           # wrangler dev (guards fail open without KV/limiter)
```

Deploys are **manual** (this repo is not covered by the ppn-mono CI pipeline):

```bash
pnpm exec wrangler kv namespace create FREE_KV   # once; paste the id into wrangler.toml
pnpm exec wrangler secret put FREE_TIER_BACKEND_KEY --env production
pnpm exec wrangler secret put IP_HASH_SALT --env production   # openssl rand -hex 32
pnpm run deploy
```

## License

[MIT](LICENSE)
