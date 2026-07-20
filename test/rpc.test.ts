import { describe, it, expect } from 'vitest';
import { inspectRpc, denyBody, patchToolsListText, QUICKSTART_URL, UNIT_COST } from '../src/rpc.js';

// Fixed allowlist double: onokoro:getElevation is the only allowed operation.
const isAllowed = (api: string, operationId: string) =>
  api === 'onokoro' && operationId === 'getElevation';

const call = (name: string, args: Record<string, unknown> = {}, id: number = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('inspectRpc — single messages', () => {
  it('passes initialize through with no key and no cost', () => {
    const d = inspectRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, isAllowed);
    expect(d).toEqual({
      kind: 'forward',
      needsKey: false,
      units: 0,
      patchToolsList: false,
      apisTouched: [],
    });
  });

  it('flags tools/list for description patching', () => {
    const d = inspectRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, isAllowed);
    expect(d).toMatchObject({ kind: 'forward', needsKey: false, units: 0, patchToolsList: true });
  });

  it('forwards search_apis anonymously at 1 unit', () => {
    const d = inspectRpc(call('search_apis', { query: 'weather' }), isAllowed);
    expect(d).toMatchObject({ kind: 'forward', needsKey: false, units: UNIT_COST.toolCall });
  });

  it('injects the key for an allowlisted GET execute_api', () => {
    const d = inspectRpc(call('execute_api', { api: 'onokoro', operationId: 'getElevation' }), isAllowed);
    expect(d).toEqual({
      kind: 'forward',
      needsKey: true,
      units: 1,
      patchToolsList: false,
      apisTouched: ['onokoro'],
    });
  });

  it('denies a non-allowlisted (write) operation with a quickstart pointer', () => {
    const d = inspectRpc(call('execute_api', { api: 'onokoro', operationId: 'postFeedback' }, 7), isAllowed);
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.id).toBe(7);
    expect(d.message).toContain(QUICKSTART_URL);
    expect(d.apisTouched).toEqual(['onokoro']); // denied attempts still feed the enum guard
  });

  it('denies an unknown api without crashing on missing arguments', () => {
    const d = inspectRpc(call('execute_api'), isAllowed);
    expect(d.kind).toBe('deny');
  });

  it('allows environment_brief with key injection at 10 units', () => {
    const d = inspectRpc(call('environment_brief', { lat: 35.6, lon: 139.7 }), isAllowed);
    expect(d).toMatchObject({ kind: 'forward', needsKey: true, units: UNIT_COST.environmentBrief });
  });

  it('denies unknown tools', () => {
    const d = inspectRpc(call('drop_tables'), isAllowed);
    expect(d.kind).toBe('deny');
  });

  it('denies a message with no method', () => {
    const d = inspectRpc({ jsonrpc: '2.0', id: 3 }, isAllowed);
    expect(d.kind).toBe('deny');
  });
});

describe('inspectRpc — batches', () => {
  it('sums units and ORs key injection across a clean batch', () => {
    const d = inspectRpc(
      [
        call('search_apis', { query: 'weather' }, 1),
        call('execute_api', { api: 'onokoro', operationId: 'getElevation' }, 2),
      ],
      isAllowed,
    );
    expect(d).toMatchObject({ kind: 'forward', needsKey: true, units: 2, apisTouched: ['onokoro'] });
  });

  it('rejects the whole batch when one element is denied (header-level key injection)', () => {
    const d = inspectRpc(
      [
        call('execute_api', { api: 'onokoro', operationId: 'getElevation' }, 1),
        call('execute_api', { api: 'onokoro', operationId: 'postFeedback' }, 2),
      ],
      isAllowed,
    );
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.id).toBe(2); // the offending element's id
  });

  it('rejects an empty batch', () => {
    expect(inspectRpc([], isAllowed).kind).toBe('deny');
  });
});

describe('denyBody', () => {
  it('is a tool-style error result, not a transport error', () => {
    const body = denyBody(9, 'nope') as {
      id: number;
      result: { isError: boolean; content: { text: string }[] };
      error?: unknown;
    };
    expect(body.id).toBe(9);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    const inner = JSON.parse(body.result.content[0].text);
    expect(inner.error.code).toBe('FREE_TIER_RESTRICTED');
  });
});

describe('patchToolsListText', () => {
  const toolsPayload = {
    result: {
      tools: [
        { name: 'search_apis', description: 'Search across endpoints.' },
        { name: 'execute_api', description: "Execute. Requires 'Authorization: Bearer ppn_live_*'." },
        { name: 'environment_brief', description: 'Brief for one location.' },
      ],
    },
    jsonrpc: '2.0',
    id: 1,
  };

  it('appends free-tier notes in SSE bodies', () => {
    const sse = `event: message\ndata: ${JSON.stringify(toolsPayload)}\n\n`;
    const patched = patchToolsListText(sse, 'text/event-stream');
    expect(patched).toContain('event: message');
    const data = JSON.parse(patched.split('\n')[1].slice(6));
    expect(data.result.tools[1].description).toContain(QUICKSTART_URL);
    expect(data.result.tools[2].description).toContain('Free tier');
    expect(data.result.tools[0].description).toBe('Search across endpoints.');
  });

  it('patches plain JSON bodies', () => {
    const patched = JSON.parse(patchToolsListText(JSON.stringify(toolsPayload), 'application/json'));
    expect(patched.result.tools[1].description).toContain(QUICKSTART_URL);
  });

  it('leaves non-tools and malformed bodies untouched', () => {
    const other = JSON.stringify({ result: { content: [] }, jsonrpc: '2.0', id: 2 });
    expect(patchToolsListText(other, 'application/json')).toBe(other);
    expect(patchToolsListText('not json', 'application/json')).toBe('not json');
  });
});
