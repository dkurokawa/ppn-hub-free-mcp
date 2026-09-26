/**
 * GlobalBudget — Durable Object that enforces the shared free-tier daily
 * budget exactly, unlike the per-IP counters in guard.ts (KV, best-effort).
 *
 * A single named instance ("global", see guard.ts) backs the whole Worker.
 * Cloudflare serializes fetch() calls to one Durable Object instance, so the
 * read-then-write inside consume()/refund() below never races with another
 * request for the same day — that serialization IS the atomicity guarantee,
 * no extra locking needed.
 *
 * Routes (internal only — reached from src/guard.ts via the DO stub, never
 * exposed to MCP clients directly):
 *   POST /consume { day, units, limit } → { allowed, used }
 *     Charges `units` against the counter for `day` unless doing so would
 *     exceed `limit`. Rejected requests are not charged.
 *   POST /refund  { day, units }        → { used }
 *     Gives back units previously consumed (upstream failure — see guard.ts
 *     refundGlobalBudget / index.ts).
 */

/** Minimal storage surface this DO needs (the real DurableObjectStorage is a superset). */
export interface DurableStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** Minimal state surface this DO needs (the real DurableObjectState is a superset). */
export interface DurableStateLike {
  storage: DurableStorageLike;
}

interface ConsumeRequestBody {
  day: string;
  units: number;
  limit: number;
}

interface RefundRequestBody {
  day: string;
  units: number;
}

function isConsumeBody(body: unknown): body is ConsumeRequestBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Partial<ConsumeRequestBody>;
  return typeof b.day === 'string' && typeof b.units === 'number' && typeof b.limit === 'number';
}

function isRefundBody(body: unknown): body is RefundRequestBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Partial<RefundRequestBody>;
  return typeof b.day === 'string' && typeof b.units === 'number';
}

function storageKey(day: string): string {
  return `used:${day}`;
}

export class GlobalBudget implements DurableObject {
  constructor(private readonly state: DurableStateLike) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const { pathname } = new URL(request.url);
    if (pathname !== '/consume' && pathname !== '/refund') {
      return new Response('Not Found', { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    return pathname === '/consume' ? this.consume(body) : this.refund(body);
  }

  private async consume(body: unknown): Promise<Response> {
    if (!isConsumeBody(body)) {
      return Response.json({ error: 'invalid consume request' }, { status: 400 });
    }
    const key = storageKey(body.day);
    const used = (await this.state.storage.get<number>(key)) ?? 0;
    if (used + body.units > body.limit) {
      return Response.json({ allowed: false, used });
    }
    const next = used + body.units;
    await this.state.storage.put(key, next);
    return Response.json({ allowed: true, used: next });
  }

  private async refund(body: unknown): Promise<Response> {
    if (!isRefundBody(body)) {
      return Response.json({ error: 'invalid refund request' }, { status: 400 });
    }
    const key = storageKey(body.day);
    const used = (await this.state.storage.get<number>(key)) ?? 0;
    const next = Math.max(0, used - body.units);
    await this.state.storage.put(key, next);
    return Response.json({ used: next });
  }
}
