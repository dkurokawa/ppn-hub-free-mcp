#!/usr/bin/env node
/**
 * Regenerate allowlist.json from the LIVE gateway's public surface.
 *
 *   node scripts/gen-allowlist.mjs [--base https://mcp.ppn-hub.com] [--out allowlist.json] [--allow-truncated]
 *
 * Strategy: enumerate the public API names from GET {base}/stats, then for
 * each API call the anonymous `search_apis` tool with `query=<api name>`,
 * `method=GET` (the gateway matches the api-name field, so this returns the
 * API's full GET surface). Only entries whose `api` field matches exactly are
 * kept, and the exclusion rules below are applied.
 *
 * The anonymous search limit upstream is 60 req/60s per IP, so requests are
 * throttled to ~1.1s apart (~90s for 75 APIs).
 *
 * If any API's search hits the SEARCH_LIMIT-result cap, its GET surface may
 * be truncated — the script refuses to write allowlist.json in that case
 * (pass --allow-truncated to write anyway).
 *
 * Cost inventory (2026-07-20): every GET operationId currently exposed by
 * the gateway's AI-chain APIs (hydrogen, sakurahub-address, green-path-api,
 * science-ecology/climate/geology) serves from D1/KV — AI/paid providers are
 * only reachable via POST. The EXCLUDES below therefore match nothing today;
 * they are drift guards for endpoints known to be AI-driven in the backing
 * code, in case a future spec regeneration ever publishes them.
 */

import { pathToFileURL } from 'node:url';

export const EXCLUDES = {
  /** Whole APIs to drop, e.g. { api: 'x', reason: '...' } */
  apis: [],
  /** Exact operations to drop: { api, operationId, reason } */
  operations: [],
  /** Path patterns to drop: { api ('*' = any), pattern (RegExp), reason } */
  paths: [
    {
      api: 'green-path-api',
      pattern: /\/paper-tips/,
      reason: 'GET but triggers Gemini per call (not in the published spec today; drift guard)',
    },
    {
      api: '*',
      pattern: /\/ai\//,
      reason: 'AI sub-surface — never keyless (drift guard)',
    },
  ],
};

export const SEARCH_LIMIT = 50;
const THROTTLE_MS = 1100;

export function parseArgs(argv) {
  const args = { base: 'https://mcp.ppn-hub.com', out: 'allowlist.json', allowTruncated: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--allow-truncated') args.allowTruncated = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract the JSON-RPC result from a plain-JSON or SSE response body. */
function parseRpcBody(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const parsed = JSON.parse(line.slice(6));
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
    }
    throw new Error('No JSON-RPC message found in SSE body');
  }
  return JSON.parse(text);
}

async function searchGetEndpoints(base, api) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search_apis',
        arguments: { query: api, method: 'GET', limit: SEARCH_LIMIT },
      },
    }),
  });
  if (!res.ok) throw new Error(`search_apis(${api}) → HTTP ${res.status}`);
  const rpc = parseRpcBody(await res.text(), res.headers.get('content-type') ?? '');
  if (rpc.error) throw new Error(`search_apis(${api}) → RPC error: ${JSON.stringify(rpc.error)}`);
  const payload = JSON.parse(rpc.result.content[0].text);
  if (payload?.error) throw new Error(`search_apis(${api}) → tool error: ${JSON.stringify(payload.error)}`);
  return payload.results ?? [];
}

/** Pure: is this (api, operationId, path) entry excluded, and if so why? */
export function isExcluded(entry, excludes = EXCLUDES) {
  for (const e of excludes.apis) {
    if (e.api === entry.api) return e.reason;
  }
  for (const e of excludes.operations) {
    if (e.api === entry.api && e.operationId === entry.operationId) return e.reason;
  }
  for (const e of excludes.paths) {
    if ((e.api === '*' || e.api === entry.api) && e.pattern.test(entry.path)) return e.reason;
  }
  return null;
}

/**
 * Pure: partition one API's raw search_apis results into allow/excluded
 * entries, and flag whether the result set may have been truncated by the
 * search cap or came back with no GET surface at all. No I/O.
 */
export function partitionApiResults(api, results, excludes = EXCLUDES) {
  const own = results.filter((r) => r.api === api && r.method === 'GET');
  const allow = [];
  const excluded = [];
  for (const r of own) {
    const entry = { api: r.api, operationId: r.operationId, path: r.path, method: r.method };
    const reason = isExcluded(entry, excludes);
    if (reason !== null) excluded.push({ ...entry, reason });
    else allow.push(entry);
  }
  return {
    allow,
    excluded,
    truncated: results.length === SEARCH_LIMIT,
    empty: own.length === 0,
  };
}

/** Pure (given `now`): build the allowlist.json document from accumulated entries. */
export function buildDoc(base, allow, excluded, now = new Date()) {
  const sorted = [...allow].sort((a, b) => `${a.api}:${a.operationId}`.localeCompare(`${b.api}:${b.operationId}`));
  return {
    generated_at: now.toISOString(),
    source: `${base}/mcp (anonymous search_apis sweep)`,
    api_count: new Set(sorted.map((e) => e.api)).size,
    endpoint_count: sorted.length,
    excluded,
    allow: sorted,
  };
}

async function main() {
  const { base, out, allowTruncated } = parseArgs(process.argv);

  const statsRes = await fetch(`${base}/stats`);
  if (!statsRes.ok) throw new Error(`GET ${base}/stats → HTTP ${statsRes.status}`);
  const apis = (await statsRes.json()).data.apis.sort();
  console.log(`APIs on the public surface: ${apis.length}`);

  let allow = [];
  let excluded = [];
  const emptyApis = [];
  const maybeTruncated = [];

  for (const api of apis) {
    const results = await searchGetEndpoints(base, api);
    const partition = partitionApiResults(api, results);
    allow = allow.concat(partition.allow);
    excluded = excluded.concat(partition.excluded);
    if (partition.truncated) maybeTruncated.push(api);
    if (partition.empty) emptyApis.push(api);
    process.stdout.write(`  ${api}: ${partition.allow.length} GET\n`);
    await sleep(THROTTLE_MS);
  }

  if (maybeTruncated.length > 0 && !allowTruncated) {
    console.error(
      `Refusing to write ${out}: hit the ${SEARCH_LIMIT}-result search cap for ${maybeTruncated.length} ` +
        `API(s) — the GET surface may be truncated: ${maybeTruncated.join(', ')}. ` +
        `Re-run with --allow-truncated to write anyway.`,
    );
    process.exit(1);
  }

  const doc = buildDoc(base, allow, excluded);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);

  console.log(`\nWrote ${out}: ${doc.endpoint_count} GET endpoints across ${doc.api_count} APIs`);
  if (excluded.length > 0) console.log(`Excluded ${excluded.length}:`, excluded);
  if (emptyApis.length > 0) console.log(`APIs with no GET surface (verify manually): ${emptyApis.join(', ')}`);
  if (maybeTruncated.length > 0)
    console.log(`⚠️ Wrote anyway with --allow-truncated. Possibly truncated APIs: ${maybeTruncated.join(', ')}`);
}

// pathToFileURL encodes spaces / non-ASCII the same way import.meta.url does.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
