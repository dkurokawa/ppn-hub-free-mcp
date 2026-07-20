import { describe, it, expect } from 'vitest';
import {
  hashIp,
  dayStamp,
  isBanned,
  consumeBudget,
  recordDenied,
  recordApiSpread,
  ERR_BAN_THRESHOLD,
  ENUM_BAN_THRESHOLD,
  type KvLike,
} from '../src/guard.js';

/** In-memory KV double (TTLs recorded but not enforced). */
class FakeKv implements KvLike {
  store = new Map<string, string>();
  ttls = new Map<string, number | undefined>();
  failing = false;

  async get(key: string): Promise<string | null> {
    if (this.failing) throw new Error('kv down');
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (this.failing) throw new Error('kv down');
    this.store.set(key, value);
    this.ttls.set(key, options?.expirationTtl);
  }
}

const NOW = new Date('2026-07-20T12:00:00Z');
const LIMITS = { ipDay: 100, globalDay: 5000 };

describe('hashIp', () => {
  it('returns a stable 16-char hex hash', async () => {
    const a = await hashIp('203.0.113.9', 'salt');
    const b = await hashIp('203.0.113.9', 'salt');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes with the salt (raw IP is not recoverable across salts)', async () => {
    expect(await hashIp('203.0.113.9', 'salt-a')).not.toBe(await hashIp('203.0.113.9', 'salt-b'));
  });
});

describe('dayStamp', () => {
  it('partitions by UTC day', () => {
    expect(dayStamp(new Date('2026-07-20T23:59:59Z'))).toBe('20260720');
    expect(dayStamp(new Date('2026-07-21T00:00:01Z'))).toBe('20260721');
  });
});

describe('consumeBudget — per-IP daily cap', () => {
  it('allows and accumulates under the cap', async () => {
    const kv = new FakeKv();
    for (let i = 0; i < 5; i++) {
      expect((await consumeBudget(kv, 'aaaa', 1, NOW, LIMITS)).allowed).toBe(true);
    }
    expect(kv.store.get('free-day:aaaa:20260720')).toBe('5');
    expect(kv.store.get('free-global:20260720')).toBe('5');
  });

  it('allows exactly up to the cap, then rejects with scope=ip', async () => {
    const kv = new FakeKv();
    kv.store.set('free-day:aaaa:20260720', '99');
    expect((await consumeBudget(kv, 'aaaa', 1, NOW, LIMITS)).allowed).toBe(true); // 100th unit
    const denied = await consumeBudget(kv, 'aaaa', 1, NOW, LIMITS);
    expect(denied).toEqual({ allowed: false, scope: 'ip' });
    // A rejected request must not consume budget.
    expect(kv.store.get('free-day:aaaa:20260720')).toBe('100');
  });

  it('charges environment_brief-sized units in one step', async () => {
    const kv = new FakeKv();
    kv.store.set('free-day:aaaa:20260720', '95');
    const denied = await consumeBudget(kv, 'aaaa', 10, NOW, LIMITS);
    expect(denied).toEqual({ allowed: false, scope: 'ip' }); // 95 + 10 > 100
    expect((await consumeBudget(kv, 'aaaa', 5, NOW, LIMITS)).allowed).toBe(true);
  });

  it('resets on UTC day rollover', async () => {
    const kv = new FakeKv();
    kv.store.set('free-day:aaaa:20260720', '100');
    const nextDay = new Date('2026-07-21T00:00:01Z');
    expect((await consumeBudget(kv, 'aaaa', 1, nextDay, LIMITS)).allowed).toBe(true);
    expect(kv.store.get('free-day:aaaa:20260721')).toBe('1');
  });
});

describe('consumeBudget — global daily cap (fail-closed)', () => {
  it('rejects with scope=global when the shared budget is exhausted, even for a fresh IP', async () => {
    const kv = new FakeKv();
    kv.store.set('free-global:20260720', '5000');
    const denied = await consumeBudget(kv, 'fresh-ip-hash', 1, NOW, LIMITS);
    expect(denied).toEqual({ allowed: false, scope: 'global' });
  });

  it('allows exactly up to the global cap', async () => {
    const kv = new FakeKv();
    kv.store.set('free-global:20260720', '4999');
    expect((await consumeBudget(kv, 'aaaa', 1, NOW, LIMITS)).allowed).toBe(true);
    expect(kv.store.get('free-global:20260720')).toBe('5000');
  });

  it('fails open when KV is unavailable (minute limiter still bounds abuse)', async () => {
    const kv = new FakeKv();
    kv.failing = true;
    expect((await consumeBudget(kv, 'aaaa', 1, NOW, LIMITS)).allowed).toBe(true);
  });

  it('charges nothing for zero-unit requests', async () => {
    const kv = new FakeKv();
    expect((await consumeBudget(kv, 'aaaa', 0, NOW, LIMITS)).allowed).toBe(true);
    expect(kv.store.has('free-day:aaaa:20260720')).toBe(false);
  });
});

describe('ban list', () => {
  it('isBanned reflects the ban key and fails open on KV errors', async () => {
    const kv = new FakeKv();
    expect(await isBanned(kv, 'aaaa')).toBe(false);
    kv.store.set('free-ban:aaaa', '1');
    expect(await isBanned(kv, 'aaaa')).toBe(true);
    kv.failing = true;
    expect(await isBanned(kv, 'aaaa')).toBe(false);
  });

  it(`recordDenied bans at the ${ERR_BAN_THRESHOLD}th strike, not before`, async () => {
    const kv = new FakeKv();
    for (let i = 0; i < ERR_BAN_THRESHOLD - 1; i++) await recordDenied(kv, 'aaaa');
    expect(kv.store.has('free-ban:aaaa')).toBe(false);
    await recordDenied(kv, 'aaaa');
    expect(kv.store.get('free-ban:aaaa')).toBe('1');
  });

  it(`recordApiSpread bans at ${ENUM_BAN_THRESHOLD} distinct APIs in the window`, async () => {
    const kv = new FakeKv();
    const batch1 = Array.from({ length: ENUM_BAN_THRESHOLD - 1 }, (_, i) => `api-${i}`);
    await recordApiSpread(kv, 'aaaa', batch1);
    expect(kv.store.has('free-ban:aaaa')).toBe(false);
    await recordApiSpread(kv, 'aaaa', ['api-last']);
    expect(kv.store.get('free-ban:aaaa')).toBe('1');
  });

  it('recordApiSpread counts DISTINCT apis — repeats never ban', async () => {
    const kv = new FakeKv();
    for (let i = 0; i < ENUM_BAN_THRESHOLD * 2; i++) {
      await recordApiSpread(kv, 'aaaa', ['same-api']);
    }
    expect(kv.store.has('free-ban:aaaa')).toBe(false);
    expect(JSON.parse(kv.store.get('free-enum:aaaa')!)).toEqual(['same-api']);
  });

  it('recordApiSpread survives a corrupted counter', async () => {
    const kv = new FakeKv();
    kv.store.set('free-enum:aaaa', 'not-json');
    await recordApiSpread(kv, 'aaaa', ['api-x']);
    expect(JSON.parse(kv.store.get('free-enum:aaaa')!)).toEqual(['api-x']);
  });
});
