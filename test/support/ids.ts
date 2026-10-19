import { parseGameId, parsePortalUserId, type GameId, type PortalUserId } from '@g4k/sdk';

export function gameId(raw: string): GameId {
	const id = parseGameId(raw);
	if (typeof id !== 'string') throw new Error(id.problem);
	return id;
}

export function portalUserId(raw: string): PortalUserId {
	const id = parsePortalUserId(raw);
	if (!id) throw new Error(`${raw} is not a PortalUserId`);
	return id;
}
