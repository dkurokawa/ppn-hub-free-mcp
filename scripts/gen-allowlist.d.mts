/** Type declarations for the pure functions exported by gen-allowlist.mjs (used by test/gen-allowlist.test.ts). */

export interface AllowlistEntry {
  api: string;
  operationId: string;
  path: string;
  method: string;
}

export interface ExcludedEntry extends AllowlistEntry {
  reason: string;
}

export interface SearchResult {
  api: string;
  operationId: string;
  path: string;
  method: string;
}

export interface ExcludeRule {
  api: string;
  reason: string;
  operationId?: string;
  pattern?: RegExp;
}

export interface Excludes {
  apis: ExcludeRule[];
  operations: ExcludeRule[];
  paths: ExcludeRule[];
}

export const EXCLUDES: Excludes;
export const SEARCH_LIMIT: number;

export function isExcluded(entry: AllowlistEntry, excludes?: Excludes): string | null;

export interface PartitionResult {
  allow: AllowlistEntry[];
  excluded: ExcludedEntry[];
  truncated: boolean;
  empty: boolean;
}

export function partitionApiResults(api: string, results: SearchResult[], excludes?: Excludes): PartitionResult;

export interface AllowlistDoc {
  generated_at: string;
  source: string;
  api_count: number;
  endpoint_count: number;
  excluded: ExcludedEntry[];
  allow: AllowlistEntry[];
}

export function buildDoc(base: string, allow: AllowlistEntry[], excluded: ExcludedEntry[], now?: Date): AllowlistDoc;

export interface ParsedArgs {
  base: string;
  out: string;
  allowTruncated: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs;
