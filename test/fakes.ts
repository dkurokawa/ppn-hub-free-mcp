/** Shared test doubles for the free-tier proxy's guards. */
import type { KvLike, GlobalBudgetNamespaceLike } from '../src/guard.js';
import { GlobalBudget, type DurableStateLike, type DurableStorageLike } from '../src/global-budget.js';

/** In-memory KV double (TTLs recorded but not enforced). */
export class FakeKv implements KvLike {
  store = new Map<string, string>();
  ttls = new Map<string, number | undefined>();
  failing = false;

  get(key: string): Promise<string | null> {
    if (this.failing) return Promise.reject(new Error('kv down'));
    return Promise.resolve(this.store.get(key) ?? null);
  }
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (this.failing) return Promise.reject(new Error('kv down'));
    this.store.set(key, value);
    this.ttls.set(key, options?.expirationTtl);
    return Promise.resolve();
  }
}

/** In-memory Durable Object storage double, backing a real GlobalBudget instance in tests. */
class FakeDurableStorage implements DurableStorageLike {
  store = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.store.get(key) as T | undefined);
  }
  put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

/**
 * Wraps a real GlobalBudget instance behind the minimal namespace surface
 * index.ts/guard.ts use, so app-level tests exercise the actual DO logic
 * (not a re-implementation of it) without a real Workers runtime.
 */
export function makeFakeGlobalBudgetNamespace(): GlobalBudgetNamespaceLike & { storage: FakeDurableStorage } {
  const storage = new FakeDurableStorage();
  const state: DurableStateLike = { storage };
  const instance = new GlobalBudget(state);
  return {
    storage,
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (url: string, init: RequestInit) => instance.fetch(new Request(url, init)),
    }),
  };
}

/** Cloudflare-native rate limiter double. */
export function makeFakeRateLimiter(success = true): { limit: (options: { key: string }) => Promise<{ success: boolean }> } {
  return { limit: () => Promise.resolve({ success }) };
}

/** Collects ExecutionContext.waitUntil() tasks so tests can await them before asserting. */
export function makeExecutionCtx(): { ctx: ExecutionContext; flush: () => Promise<unknown[]> } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      tasks.push(promise);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, flush: () => Promise.all(tasks) };
}
