export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Row keys sort ascending, so a later instant gets a smaller key and the newest row comes first. */
export const invertedTime = (ms: number): string => String(9_999_999_999_999 - ms).padStart(13, '0');
