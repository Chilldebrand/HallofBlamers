/**
 * Small defensive-parsing helpers shared by `validate.ts`, `normalize.ts`,
 * and `franchise-map.ts`. Every ESPN payload field is typed `unknown` in
 * `espn-shapes.ts` on purpose (see that file's header) — these narrow a
 * value to a usable primitive or return `undefined`/`null` instead of
 * throwing, per the brief's "optional-chain everything, warn and skip"
 * parsing policy.
 */

export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Normalizes an ESPN `owners[]` entry to a SWID string. Modern payloads use
 * plain SWID strings; some older/alternate shapes wrap it as `{ id: swid }`.
 * Returns `undefined` for anything else rather than guessing.
 */
export function asOwnerSwid(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/** Stable (recursively key-sorted) JSON stringification, for content-equality comparisons. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}
