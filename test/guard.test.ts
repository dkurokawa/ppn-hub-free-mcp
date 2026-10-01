import { describe, it, expect } from 'vitest';
import {
  hashIp,
  dayStamp,
  isBanned,
  checkIpBudget,
  chargeIpBudget,
  refundIpBudget,
  consumeGlobalBudget,
  refundGlobalBudget,
  recordDenied,
  recordApiSpread,
  ERR_BAN_THRESHOLD,
  ENUM_BAN_THRESHOLD,
} from '../src/guard.js';
import { FakeKv, makeFakeGlobalBudgetNamespace } from './fakes.js';

const NOW = new Date('2026-07-20T12:00:00Z');
const IP_DAY_LIMIT = 100;
const GLOBAL_DAY_LIMIT = 5000;

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

describe('checkIpBudget / chargeIpBudget — per-IP daily cap (KV, approximate)', () => {
  it('allows and, once charged, accumulates under the cap', async () => {
    const kv = new FakeKv();
    for (let i = 0; i < 5; i++) {
      expect((await checkIpBudget(kv, 'aaaa', 1, NOW, IP_DAY_LIMIT)).allowed).toBe(true);
      await chargeIpBudget(kv, 'aaaa', 1, NOW);
    }
    expect(kv.store.get('free-day:aaaa:20260720')).toBe('5');
  });

  it('allows exactly up to the cap, then rejects without charging further', async () => {
    const kv = new FakeKv();
    kv.store.set('free-day:aaaa:20260720', '99');
    expect((await checkIpBudget(kv, 'aaaa', 1, NOW, IP_DAY_LIMIT)).allowed).toBe(true); // 100th unit
    await chargeIpBudget(kv, 'aaaa', 1, NOW);
    expect(kv.store.get('free-day:aaaa:20260720')).toBe('100');

    expect((await checkIpBudget(kv, 'aaaa', 1, NOW, IP_DAY_LIMIT)).allowed).toBe(false);
    // A rejected check must not have charged anything.
    expect(kv.store.get('free-day:aaaa:20260720')).toBe('100');
  });

  it('checkIpBudget does not write — repeated checks without a charge never accumulate', async () => {
    const kv = new FakeKv();
    await checkIpBudget(kv, 'aaaa', 1, NOW, IP_DAY_LIMIT);
    await checkIpBudget(kv, 'aaaa', 1, NOW, IP_DAY_LIMIT);
    expect(kv.store.has('free-day:aaaa:20260720')).toBe(false);
  });

  it('rejects environment_brief-sized (10-unit) charges that would cross the cap', async () => {
    const kv = new FakeKv();
    kv.store.set('free-day:aaaa:20260720', '95');
    expect((await checkIpBudget(kv, 'aaaa', 10, NOW, IP_DAY_LIMIT)).allowed).toBe(false); // 95 + 10 > 100
    expect((await checkIpBudget(kv, 'aaaa', 5, NOW, IP_DAY_LIMIT)).allowed).toBe(true);
  });

  it('resets on UTC day rollover', async () => {
    const kv = new FakeKv();
    kv.store.set('free-day:aaaa:20260720', '100');
    const nextDay = new Date('2026-07-21T00:00:01Z');
    expect((await checkIpBudget(kv, 'aaaa', 1, nextDay, IP_DAY_LIMIT)).allowed).toBe(true);
    await chargeIpBudget(kv, 'aaaa', 1, nextDay);
    expect(kv.store.get('free-day:aaaa:20260721')).toBe('1');
  });

  it('fails open when KV is unavailable (minute limiter still bounds abuse)', async () => {
    const kv = new FakeKv();
    kv.failing = true;
    expect((await checkIpBudget(kv, 'aaaa', 1, NOW, IP_DAY_LIMIT)).allowed).toBe(true);
  });

  it('charges nothing for zero-unit requests', async () => {
    const kv = new FakeKv();
    expect((await checkIpBudget(kv, 'aaaa', 0, NOW, IP_DAY_LIMIT)).allowed).toBe(true);
    await chargeIpBudget(kv, 'aaaa', 0, NOW);
    expect(kv.store.has('free-day:aaaa:20260720')).toBe(false);
  });
});

describe('refundIpBudget', () => {
  it('gives back units to the per-IP counter', async () => {
    const kv = new FakeKv();
    kv.store.set('free-day:aaaa:20260720', '10');
    await refundIpBudget(kv, 'aaaa', 4, NOW);
    expect(kv.store.get('free-day:aaaa:20260720')).toBe('6');
  });

  it('never goes below zero', async () => {
    const kv = new FakeKv();
    kv.store.set('free-day:aaaa:20260720', '2');
    await refundIpBudget(kv, 'aaaa', 10, NOW);
    expect(kv.store.get('free-day:aaaa:20260720')).toBe('0');
  });

  it('does nothing for zero-unit refunds', async () => {
    const kv = new FakeKv();
    await refundIpBudget(kv, 'aaaa', 0, NOW);
    expect(kv.store.has('free-day:aaaa:20260720')).toBe(false);
  });
});

describe('consumeGlobalBudget / refundGlobalBudget — global daily cap (Durable Object, exact, fail-closed)', () => {
  it('fails open when the Durable Object call throws, and a failed refund does not throw', async () => {
    const broken = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.reject(new Error('DO unavailable')) }),
    } as unknown as Parameters<typeof consumeGlobalBudget>[0];
    expect((await consumeGlobalBudget(broken, NOW, 1, GLOBAL_DAY_LIMIT)).allowed).toBe(true);
    await expect(refundGlobalBudget(broken, NOW, 1)).resolves.toBeUndefined();
  });

  it('fails open when the Durable Object replies without an `allowed` field', async () => {
    for (const reply of [Response.json({ error: 'invalid consume request' }, { status: 400 }), Response.json({})]) {
      const odd = {
        idFromName: (name: string) => name,
        get: () => ({ fetch: () => Promise.resolve(reply) }),
      } as unknown as Parameters<typeof consumeGlobalBudget>[0];
      expect((await consumeGlobalBudget(odd, NOW, 1, GLOBAL_DAY_LIMIT)).allowed).toBe(true);
    }
  });

  it('allows and accumulates under the cap', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    for (let i = 0; i < 5; i++) {
      expect((await consumeGlobalBudget(ns, NOW, 1, GLOBAL_DAY_LIMIT)).allowed).toBe(true);
    }
    expect(await ns.storage.get<number>('used:20260720')).toBe(5);
  });

  it('rejects with scope=global when the shared budget is exhausted, even for a fresh IP', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    await ns.storage.put('used:20260720', GLOBAL_DAY_LIMIT);
    expect((await consumeGlobalBudget(ns, NOW, 1, GLOBAL_DAY_LIMIT)).allowed).toBe(false);
  });

  it('allows exactly up to the global cap', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    await ns.storage.put('used:20260720', GLOBAL_DAY_LIMIT - 1);
    expect((await consumeGlobalBudget(ns, NOW, 1, GLOBAL_DAY_LIMIT)).allowed).toBe(true);
    expect(await ns.storage.get<number>('used:20260720')).toBe(GLOBAL_DAY_LIMIT);
  });

  it('does not charge a rejected request', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    await ns.storage.put('used:20260720', GLOBAL_DAY_LIMIT);
    await consumeGlobalBudget(ns, NOW, 1, GLOBAL_DAY_LIMIT);
    expect(await ns.storage.get<number>('used:20260720')).toBe(GLOBAL_DAY_LIMIT);
  });

  it('refunds previously charged units', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    await consumeGlobalBudget(ns, NOW, 10, GLOBAL_DAY_LIMIT);
    await refundGlobalBudget(ns, NOW, 4);
    expect(await ns.storage.get<number>('used:20260720')).toBe(6);
  });

  it('refund never goes below zero', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    await consumeGlobalBudget(ns, NOW, 2, GLOBAL_DAY_LIMIT);
    await refundGlobalBudget(ns, NOW, 10);
    expect(await ns.storage.get<number>('used:20260720')).toBe(0);
  });

  it('resets on UTC day rollover (separate storage keys per day)', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    await ns.storage.put('used:20260720', GLOBAL_DAY_LIMIT);
    const nextDay = new Date('2026-07-21T00:00:01Z');
    expect((await consumeGlobalBudget(ns, nextDay, 1, GLOBAL_DAY_LIMIT)).allowed).toBe(true);
    expect(await ns.storage.get<number>('used:20260721')).toBe(1);
  });

  it('charges/refunds nothing for zero units', async () => {
    const ns = makeFakeGlobalBudgetNamespace();
    expect((await consumeGlobalBudget(ns, NOW, 0, GLOBAL_DAY_LIMIT)).allowed).toBe(true);
    await refundGlobalBudget(ns, NOW, 0);
    expect(await ns.storage.get<number>('used:20260720')).toBeUndefined();
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
    expect(JSON.parse(kv.store.get('free-enum:aaaa')!) as string[]).toEqual(['same-api']);
  });

  it('recordApiSpread survives a corrupted counter', async () => {
    const kv = new FakeKv();
    kv.store.set('free-enum:aaaa', 'not-json');
    await recordApiSpread(kv, 'aaaa', ['api-x']);
    expect(JSON.parse(kv.store.get('free-enum:aaaa')!) as string[]).toEqual(['api-x']);
  });
});
