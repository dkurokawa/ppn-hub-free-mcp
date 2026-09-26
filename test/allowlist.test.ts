import { describe, it, expect } from 'vitest';
import { isAllowed, allowlistSize, allowlistMeta } from '../src/allowlist.js';
import allowlist from '../allowlist.json';

describe('allowlist (generated data + lookup)', () => {
  it('is non-empty and GET-only by construction', () => {
    expect(allowlistSize()).toBeGreaterThan(0);
    expect(allowlist.allow.length).toBe(allowlistSize());
    for (const e of allowlist.allow) {
      expect(e.method).toBe('GET');
    }
  });

  it('allows a listed operation', () => {
    const first = allowlist.allow[0]!;
    expect(isAllowed(first.api, first.operationId)).toBe(true);
  });

  it('denies unknown operations and APIs (deny-by-default)', () => {
    expect(isAllowed('no-such-api', 'getAnything')).toBe(false);
    const first = allowlist.allow[0]!;
    expect(isAllowed(first.api, 'operation-that-does-not-exist')).toBe(false);
  });

  it('is case-sensitive (operationIds are exact identifiers)', () => {
    const first = allowlist.allow[0]!;
    expect(isAllowed(first.api.toUpperCase(), first.operationId)).toBe(false);
  });

  it('never contains an AI sub-surface path (drift guard mirror of gen excludes)', () => {
    for (const e of allowlist.allow) {
      expect(e.path).not.toMatch(/\/ai\//);
      expect(e.path).not.toMatch(/paper-tips/);
    }
  });

  it('exposes audit metadata for the landing route', () => {
    const meta = allowlistMeta();
    expect(meta.endpoints).toBe(allowlist.allow.length);
    expect(meta.apis).toBeGreaterThan(0);
    expect(typeof meta.generated_at).toBe('string');
  });
});
