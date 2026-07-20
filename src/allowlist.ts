/**
 * Deny-by-default allowlist of (api, operationId) pairs the free tier may
 * execute without a key. Only GET read endpoints that carry no per-call
 * AI/external-billing cost make it into allowlist.json — regenerate it from
 * the LIVE gateway surface with `pnpm run gen-allowlist` (the exclusion rules
 * live in scripts/gen-allowlist.mjs).
 */
import allowlist from '../allowlist.json';

export interface AllowlistEntry {
  api: string;
  operationId: string;
  path: string;
}

const allowed: ReadonlySet<string> = new Set(
  (allowlist.allow as AllowlistEntry[]).map((e) => `${e.api}:${e.operationId}`),
);

/** True when the free tier may execute this operation without a key. */
export function isAllowed(api: string, operationId: string): boolean {
  return allowed.has(`${api}:${operationId}`);
}

export function allowlistSize(): number {
  return allowed.size;
}

/** Metadata echoed on the landing route so the deployed list is auditable. */
export function allowlistMeta(): { generated_at: string; apis: number; endpoints: number } {
  const apis = new Set((allowlist.allow as AllowlistEntry[]).map((e) => e.api));
  return {
    generated_at: allowlist.generated_at as string,
    apis: apis.size,
    endpoints: allowed.size,
  };
}
