import { describe, it, expect } from 'vitest';
import {
  isExcluded,
  partitionApiResults,
  buildDoc,
  parseArgs,
  SEARCH_LIMIT,
} from '../scripts/gen-allowlist.mjs';

describe('parseArgs', () => {
  it('defaults to the live gateway and allowlist.json', () => {
    expect(parseArgs(['node', 'gen-allowlist.mjs'])).toEqual({
      base: 'https://mcp.ppn-hub.com',
      out: 'allowlist.json',
      allowTruncated: false,
    });
  });

  it('parses --base, --out and --allow-truncated', () => {
    expect(
      parseArgs(['node', 'gen-allowlist.mjs', '--base', 'https://x', '--out', 'out.json', '--allow-truncated']),
    ).toEqual({
      base: 'https://x',
      out: 'out.json',
      allowTruncated: true,
    });
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['node', 'gen-allowlist.mjs', '--nope'])).toThrow('Unknown argument: --nope');
  });
});

describe('isExcluded', () => {
  it('excludes AI sub-surface paths regardless of api', () => {
    const reason = isExcluded({ api: 'anything', operationId: 'x', path: '/ai/chat', method: 'GET' });
    expect(reason).toMatch(/AI sub-surface/);
  });

  it('excludes green-path-api paper-tips', () => {
    const reason = isExcluded({ api: 'green-path-api', operationId: 'x', path: '/paper-tips', method: 'GET' });
    expect(reason).not.toBeNull();
  });

  it('does not exclude paper-tips on an unrelated api', () => {
    expect(isExcluded({ api: 'onokoro', operationId: 'x', path: '/paper-tips', method: 'GET' })).toBeNull();
  });

  it('allows everything else', () => {
    expect(isExcluded({ api: 'onokoro', operationId: 'getElevation', path: '/elevation', method: 'GET' })).toBeNull();
  });
});

describe('partitionApiResults', () => {
  const results = [
    { api: 'onokoro', operationId: 'getElevation', path: '/elevation', method: 'GET' },
    { api: 'onokoro', operationId: 'postFeedback', path: '/feedback', method: 'POST' },
    { api: 'onokoro', operationId: 'getAiThing', path: '/ai/thing', method: 'GET' },
    { api: 'other-api', operationId: 'getX', path: '/x', method: 'GET' },
  ];

  it('keeps only GET results scoped to the requested api', () => {
    const p = partitionApiResults('onokoro', results);
    expect(p.allow).toEqual([{ api: 'onokoro', operationId: 'getElevation', path: '/elevation', method: 'GET' }]);
  });

  it('excludes matched patterns with a reason attached', () => {
    const p = partitionApiResults('onokoro', results);
    expect(p.excluded).toHaveLength(1);
    expect(p.excluded[0]).toMatchObject({ api: 'onokoro', operationId: 'getAiThing' });
    expect(p.excluded[0]?.reason).toMatch(/AI sub-surface/);
  });

  it('flags truncation exactly at the search cap', () => {
    const full = Array.from({ length: SEARCH_LIMIT }, (_, i) => ({
      api: 'onokoro',
      operationId: `getX${i}`,
      path: `/x${i}`,
      method: 'GET',
    }));
    expect(partitionApiResults('onokoro', full).truncated).toBe(true);
    expect(partitionApiResults('onokoro', full.slice(0, -1)).truncated).toBe(false);
  });

  it('flags an api with no GET surface as empty', () => {
    const p = partitionApiResults('no-get-api', [{ api: 'no-get-api', operationId: 'postX', path: '/x', method: 'POST' }]);
    expect(p.empty).toBe(true);
    expect(p.allow).toEqual([]);
  });
});

describe('buildDoc', () => {
  it('sorts entries by api:operationId, counts distinct apis, and stamps generated_at', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const doc = buildDoc(
      'https://mcp.ppn-hub.com',
      [
        { api: 'b-api', operationId: 'getY', path: '/y', method: 'GET' },
        { api: 'a-api', operationId: 'getX', path: '/x', method: 'GET' },
      ],
      [],
      now,
    );
    expect(doc.generated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(doc.api_count).toBe(2);
    expect(doc.endpoint_count).toBe(2);
    expect(doc.allow.map((e) => e.api)).toEqual(['a-api', 'b-api']);
  });

  it('carries excluded entries through untouched', () => {
    const excluded = [{ api: 'x', operationId: 'y', path: '/ai/y', method: 'GET', reason: 'nope' }];
    const doc = buildDoc('https://mcp.ppn-hub.com', [], excluded, new Date());
    expect(doc.excluded).toBe(excluded);
    expect(doc.endpoint_count).toBe(0);
  });
});
