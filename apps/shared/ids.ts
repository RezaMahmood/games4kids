import type { Email, GameId, PortalUserId } from '@g4k/sdk';

/** The same shape as @g4k/sdk's GAME_ID, which a browser cannot import as a value. A test keeps the two equal. */
export const GAME_ID = /^[a-z][a-z0-9]{2,15}$/;

export const asGameId = (raw: unknown): GameId | null => (typeof raw === 'string' && GAME_ID.test(raw) ? (raw as GameId) : null);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const asPortalUserId = (raw: unknown): PortalUserId | null => (typeof raw === 'string' && GUID.test(raw) ? (raw.toLowerCase() as PortalUserId) : null);

export const fieldsOf = (raw: unknown): Readonly<Record<string, unknown>> => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {});

/** For a screen that says which account signed in. The host's parseEmail owns the real rule. */
export const asDisplayEmail = (raw: unknown): Email | null => (typeof raw === 'string' && raw.length <= 254 && raw.includes('@') ? (raw as Email) : null);
