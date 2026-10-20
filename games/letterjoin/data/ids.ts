const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isGuid = (value: unknown): value is string => typeof value === 'string' && GUID.test(value);
