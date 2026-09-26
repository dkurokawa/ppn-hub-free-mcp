import { describe, it, expect } from 'vitest';
import { GlobalBudget, type DurableStateLike, type DurableStorageLike } from '../src/global-budget.js';

class FakeStorage implements DurableStorageLike {
  store = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.store.get(key) as T | undefined);
  }
  put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

function makeDo(): { budget: GlobalBudget; storage: FakeStorage } {
  const storage = new FakeStorage();
  const state: DurableStateLike = { storage };
  return { budget: new GlobalBudget(state), storage };
}

const consumeReq = (body: unknown) =>
  new Request('https://global-budget.internal/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const refundReq = (body: unknown) =>
  new Request('https://global-budget.internal/refund', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GlobalBudget — routing', () => {
  it('rejects non-POST requests with 405', async () => {
    const { budget } = makeDo();
    const res = await budget.fetch(new Request('https://global-budget.internal/consume', { method: 'GET' }));
    expect(res.status).toBe(405);
  });

  it('rejects unknown paths with 404', async () => {
    const { budget } = makeDo();
    const res = await budget.fetch(new Request('https://global-budget.internal/nope', { method: 'POST' }));
    expect(res.status).toBe(404);
  });
});

describe('GlobalBudget — /consume', () => {
  it('rejects a malformed body with 400', async () => {
    const { budget } = makeDo();
    const res = await budget.fetch(consumeReq({ day: '20260720' }));
    expect(res.status).toBe(400);
  });

  it('charges under the limit and reports the running total', async () => {
    const { budget, storage } = makeDo();
    const res = await budget.fetch(consumeReq({ day: '20260720', units: 3, limit: 10 }));
    expect(await res.json()).toEqual({ allowed: true, used: 3 });
    expect(await storage.get<number>('used:20260720')).toBe(3);
  });

  it('rejects (without charging) once the limit would be exceeded', async () => {
    const { budget, storage } = makeDo();
    await budget.fetch(consumeReq({ day: '20260720', units: 8, limit: 10 }));
    const res = await budget.fetch(consumeReq({ day: '20260720', units: 3, limit: 10 }));
    expect(await res.json()).toEqual({ allowed: false, used: 8 });
    expect(await storage.get<number>('used:20260720')).toBe(8);
  });

  it('allows exactly up to the limit', async () => {
    const { budget, storage } = makeDo();
    const res = await budget.fetch(consumeReq({ day: '20260720', units: 10, limit: 10 }));
    expect(await res.json()).toEqual({ allowed: true, used: 10 });
    expect(await storage.get<number>('used:20260720')).toBe(10);
  });

  it('keeps separate counters per day', async () => {
    const { budget, storage } = makeDo();
    await budget.fetch(consumeReq({ day: '20260720', units: 5, limit: 10 }));
    await budget.fetch(consumeReq({ day: '20260721', units: 1, limit: 10 }));
    expect(await storage.get<number>('used:20260720')).toBe(5);
    expect(await storage.get<number>('used:20260721')).toBe(1);
  });
});

describe('GlobalBudget — /refund', () => {
  it('rejects a malformed body with 400', async () => {
    const { budget } = makeDo();
    const res = await budget.fetch(refundReq({ day: '20260720' }));
    expect(res.status).toBe(400);
  });

  it('gives back units and reports the new total', async () => {
    const { budget, storage } = makeDo();
    await budget.fetch(consumeReq({ day: '20260720', units: 10, limit: 100 }));
    const res = await budget.fetch(refundReq({ day: '20260720', units: 4 }));
    expect(await res.json()).toEqual({ used: 6 });
    expect(await storage.get<number>('used:20260720')).toBe(6);
  });

  it('never goes below zero', async () => {
    const { budget, storage } = makeDo();
    await budget.fetch(consumeReq({ day: '20260720', units: 2, limit: 100 }));
    const res = await budget.fetch(refundReq({ day: '20260720', units: 10 }));
    expect(await res.json()).toEqual({ used: 0 });
    expect(await storage.get<number>('used:20260720')).toBe(0);
  });

  it('refunding a day with no prior usage floors at zero', async () => {
    const { budget } = makeDo();
    const res = await budget.fetch(refundReq({ day: '20260720', units: 5 }));
    expect(await res.json()).toEqual({ used: 0 });
  });
});
