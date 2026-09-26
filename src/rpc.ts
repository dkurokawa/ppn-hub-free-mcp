/**
 * JSON-RPC inspection for the free-tier proxy.
 *
 * The proxy forwards MCP JSON-RPC to the upstream gateway, but decides per
 * request:
 *   - whether the request is even well-formed JSON-RPC 2.0 and on the
 *     method allow-list (protocol-level rejection, no tool involved),
 *   - whether to inject the free-tier backend key (only for allowlisted
 *     execute_api calls and environment_brief),
 *   - how many "units" of the daily budget the request costs,
 *   - or to reject a tools/call outright with a tool-style error pointing at
 *     the quickstart (non-GET / unknown operations, unknown tools).
 *
 * Batches are rejected outright (protocol-level, before any of the above):
 * MCP 2025-06-18 dropped JSON-RPC batching, and allowing it here would let a
 * client smuggle a denied call in alongside an allowed one that carries the
 * backend key at the HTTP-header level.
 */

export const QUICKSTART_URL = 'https://ppn-hub.com/quickstart';
export const UPSTREAM_HINT = 'https://mcp.ppn-hub.com/mcp';

const BATCH_REJECTED_MESSAGE =
  'Batch requests are not supported; send one JSON-RPC message per HTTP request.';

/** Methods the free tier forwards. Everything else is -32601 Method not found. */
const ALLOWED_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);

function isMethodAllowed(method: string): boolean {
  return ALLOWED_METHODS.has(method) || method.startsWith('notifications/');
}

/** Units charged against the daily budgets. */
export const UNIT_COST = {
  /** initialize / ping / tools/list / notifications — protocol overhead, free. */
  protocol: 0,
  toolCall: 1,
  /** environment_brief fans out to up to 8 backends per call. */
  environmentBrief: 10,
} as const;

type JsonRpcId = string | number | null;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: { name?: unknown; arguments?: Record<string, unknown> };
}

export interface ProtocolErrorBody {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string };
}

export type RpcDecision =
  | {
      /** Malformed JSON-RPC, a batch, or a method off the allow-list. Not a tool result. */
      kind: 'protocol-error';
      status: 200 | 400;
      body: ProtocolErrorBody;
    }
  | {
      /** tools/call denied by free-tier policy (unknown tool, non-allowlisted execute_api). */
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

function protocolError(status: 200 | 400, id: JsonRpcId, code: number, message: string): RpcDecision {
  return { kind: 'protocol-error', status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function inspectToolCall(id: JsonRpcId, msg: RpcMessage, isAllowed: IsAllowed): RpcDecision {
  const tool = msg.params?.name;
  const args = msg.params?.arguments ?? {};
  if (tool === 'search_apis') {
    return { kind: 'forward', needsKey: false, units: UNIT_COST.toolCall, patchToolsList: false, apisTouched: [] };
  }
  if (tool === 'environment_brief') {
    return {
      kind: 'forward',
      needsKey: true,
      units: UNIT_COST.environmentBrief,
      patchToolsList: false,
      apisTouched: [],
    };
  }
  if (tool === 'execute_api') {
    const api = typeof args.api === 'string' ? args.api : '';
    const operationId = typeof args.operationId === 'string' ? args.operationId : '';
    if (api !== '' && operationId !== '' && isAllowed(api, operationId)) {
      return {
        kind: 'forward',
        needsKey: true,
        units: UNIT_COST.toolCall,
        patchToolsList: false,
        apisTouched: [api],
      };
    }
    return {
      kind: 'deny',
      id,
      apisTouched: api === '' ? [] : [api],
      message:
        `The free tier is read-only: only allowlisted GET endpoints run without a key, and ` +
        `'${api}:${operationId}' is not on that list. Get a free ppn_live_* key for the full ` +
        `API surface at ${QUICKSTART_URL} and call ${UPSTREAM_HINT} directly.`,
    };
  }
  return {
    kind: 'deny',
    id,
    apisTouched: [],
    message: `Unknown tool '${String(tool)}'. Available tools: search_apis, execute_api, environment_brief.`,
  };
}

/** Inspect a parsed JSON-RPC payload (a single message — batches are rejected up front). */
export function inspectRpc(payload: unknown, isAllowed: IsAllowed): RpcDecision {
  if (Array.isArray(payload)) {
    return protocolError(400, null, -32600, BATCH_REJECTED_MESSAGE);
  }

  const msg: RpcMessage = payload !== null && typeof payload === 'object' ? payload : {};
  const id: JsonRpcId = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return protocolError(400, id, -32600, 'Invalid Request');
  }
  if (!isMethodAllowed(msg.method)) {
    return protocolError(200, id, -32601, 'Method not found');
  }
  if (msg.method !== 'tools/call') {
    // initialize / ping / notifications/... — pass through anonymously.
    return {
      kind: 'forward',
      needsKey: false,
      units: 0,
      patchToolsList: msg.method === 'tools/list',
      apisTouched: [],
    };
  }
  return inspectToolCall(id, msg, isAllowed);
}

/**
 * MCP tool-style error body for a denied tools/call. Shaped like the
 * upstream gateway's AUTH_REQUIRED results so MCP clients render it as a
 * tool error instead of a transport failure.
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
    if (typeof tool.description !== 'string') continue;
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
    if (Array.isArray(parsed.result?.tools)) {
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
