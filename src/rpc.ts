/**
 * JSON-RPC inspection for the free-tier proxy.
 *
 * The proxy forwards MCP JSON-RPC to the upstream gateway, but decides per
 * request (batches included):
 *   - whether to inject the free-tier backend key (only for allowlisted
 *     execute_api calls and environment_brief),
 *   - how many "units" of the daily budget the request costs,
 *   - or to reject it outright with a tool-style error pointing at the
 *     quickstart (non-GET / unknown operations, unknown tools).
 *
 * Batch semantics: header-level key injection applies to the whole HTTP
 * request, so a batch is forwarded only when EVERY element passes — one
 * denied element rejects the whole batch.
 */

export const QUICKSTART_URL = 'https://ppn-hub.com/quickstart';
export const UPSTREAM_HINT = 'https://mcp.ppn-hub.com/mcp';

/** Units charged against the daily budgets. */
export const UNIT_COST = {
  /** initialize / tools/list / notifications — protocol overhead, free. */
  protocol: 0,
  toolCall: 1,
  /** environment_brief fans out to up to 8 backends per call. */
  environmentBrief: 10,
} as const;

type JsonRpcId = string | number | null;

interface RpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: { name?: unknown; arguments?: Record<string, unknown> };
}

export type RpcDecision =
  | {
      kind: 'deny';
      id: JsonRpcId;
      message: string;
      /** APIs named in denied execute_api attempts (feeds the enum guard). */
      apisTouched: string[];
    }
  | {
      kind: 'forward';
      needsKey: boolean;
      units: number;
      patchToolsList: boolean;
      apisTouched: string[];
    };

type IsAllowed = (api: string, operationId: string) => boolean;

interface ElementVerdict {
  deny?: { id: JsonRpcId; message: string };
  needsKey: boolean;
  units: number;
  patchToolsList: boolean;
  apisTouched: string[];
}

function inspectOne(msg: RpcMessage, isAllowed: IsAllowed): ElementVerdict {
  const none: ElementVerdict = { needsKey: false, units: 0, patchToolsList: false, apisTouched: [] };
  const id = msg.id ?? null;
  if (typeof msg.method !== 'string') {
    return { ...none, deny: { id, message: 'Invalid JSON-RPC request: missing method.' } };
  }
  if (msg.method !== 'tools/call') {
    // initialize / tools/list / notifications/... — pass through anonymously.
    return { ...none, patchToolsList: msg.method === 'tools/list' };
  }
  const tool = msg.params?.name;
  const args = msg.params?.arguments ?? {};
  if (tool === 'search_apis') {
    return { ...none, units: UNIT_COST.toolCall };
  }
  if (tool === 'environment_brief') {
    return { ...none, needsKey: true, units: UNIT_COST.environmentBrief };
  }
  if (tool === 'execute_api') {
    const api = typeof args['api'] === 'string' ? args['api'] : '';
    const operationId = typeof args['operationId'] === 'string' ? args['operationId'] : '';
    if (api !== '' && operationId !== '' && isAllowed(api, operationId)) {
      return { ...none, needsKey: true, units: UNIT_COST.toolCall, apisTouched: [api] };
    }
    return {
      ...none,
      apisTouched: api === '' ? [] : [api],
      deny: {
        id,
        message:
          `The free tier is read-only: only allowlisted GET endpoints run without a key, and ` +
          `'${api}:${operationId}' is not on that list. Get a free ppn_live_* key for the full ` +
          `API surface at ${QUICKSTART_URL} and call ${UPSTREAM_HINT} directly.`,
      },
    };
  }
  return {
    ...none,
    deny: { id, message: `Unknown tool '${String(tool)}'. Available tools: search_apis, execute_api, environment_brief.` },
  };
}

/** Inspect a parsed JSON-RPC payload (single message or batch). */
export function inspectRpc(payload: unknown, isAllowed: IsAllowed): RpcDecision {
  const messages: RpcMessage[] = Array.isArray(payload) ? payload : [payload as RpcMessage];
  if (Array.isArray(payload) && payload.length === 0) {
    return { kind: 'deny', id: null, message: 'Invalid JSON-RPC request: empty batch.', apisTouched: [] };
  }

  let needsKey = false;
  let units = 0;
  let patchToolsList = false;
  const apisTouched: string[] = [];

  for (const msg of messages) {
    const v = inspectOne(msg && typeof msg === 'object' ? msg : {}, isAllowed);
    apisTouched.push(...v.apisTouched);
    if (v.deny) {
      return { kind: 'deny', id: v.deny.id, message: v.deny.message, apisTouched };
    }
    needsKey ||= v.needsKey;
    units += v.units;
    patchToolsList ||= v.patchToolsList;
  }
  return { kind: 'forward', needsKey, units, patchToolsList, apisTouched };
}

/**
 * MCP tool-style error body for a denied call. Shaped like the upstream
 * gateway's AUTH_REQUIRED results so MCP clients render it as a tool error
 * instead of a transport failure.
 */
export function denyBody(id: JsonRpcId, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: { code: 'FREE_TIER_RESTRICTED', message, status: 403 },
            },
            null,
            2,
          ),
        },
      ],
    },
  };
}

const EXECUTE_API_NOTE =
  ' Free tier (this endpoint): allowlisted GET read endpoints run WITHOUT a key;' +
  ` anything else needs a free key — ${QUICKSTART_URL}.`;
const ENVIRONMENT_BRIEF_NOTE =
  ' Free tier (this endpoint): runs WITHOUT a key and consumes 10 units of the daily free budget.';

interface ToolEntry {
  name?: string;
  description?: string;
}

function patchToolsArray(tools: ToolEntry[]): void {
  for (const tool of tools) {
    if (typeof tool?.description !== 'string') continue;
    if (tool.name === 'execute_api' && !tool.description.includes(QUICKSTART_URL)) {
      tool.description += EXECUTE_API_NOTE;
    } else if (tool.name === 'environment_brief' && !tool.description.includes('Free tier')) {
      tool.description += ENVIRONMENT_BRIEF_NOTE;
    }
  }
}

function tryPatchJson(json: string): string {
  try {
    const parsed = JSON.parse(json) as { result?: { tools?: ToolEntry[] } };
    if (Array.isArray(parsed?.result?.tools)) {
      patchToolsArray(parsed.result.tools);
      return JSON.stringify(parsed);
    }
  } catch {
    // not JSON / unexpected shape — leave untouched
  }
  return json;
}

/**
 * Rewrite execute_api / environment_brief descriptions in a tools/list
 * response so agents learn the free-tier rules. Handles both plain JSON and
 * SSE (`data: {...}`) bodies; anything unexpected passes through unchanged.
 */
export function patchToolsListText(body: string, contentType: string): string {
  if (contentType.includes('text/event-stream')) {
    return body
      .split('\n')
      .map((line) => (line.startsWith('data: ') ? `data: ${tryPatchJson(line.slice(6))}` : line))
      .join('\n');
  }
  return tryPatchJson(body);
}
