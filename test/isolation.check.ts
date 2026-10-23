/**
 * Compile-time proof, ported from docs/sketch/isolation.check.ts for the code phase 1 builds: a games token means
 * "player" and nothing more, each table has one writer, Graph needs an elevation, and an elevation cannot be forged.
 * `tsc -b` passes only if every @ts-expect-error line really is an error. The shell and migration negatives arrive
 * with phases 2 and 9.
 */
import { defineGame, definePlayApi, type AdminPlatform, type ImageTokens, type Caller, type Email, type PlayPlatform, type PlayRoute, type PortalUserId } from '@g4k/sdk';
import {
	openAdminSession,
	type AdminSession,
	type AdminStore,
	type AdminToken,
	type Authentication,
	type Elevation,
	type GraphFor,
	type Member,
	type PlayerAppDeps,
	type PortalStore,
	type Rates,
	type Telemetry,
} from '@g4k/host';
import { adminStore, playStore } from './fixtures/games/fixture/data/index.ts';
import fixture from './fixtures/games/fixture/manifest.ts';

const other = defineGame({
	id: 'other',
	title: 'Other',
	summary: '',
	icon: 'icon.svg',
	storage: { tables: { pictures: 'admin' }, containers: {}, queues: {} },
	play: { web: { kind: 'static' }, settings: {}, services: ['cognitiveServices'] },
});

declare const play: PlayPlatform<typeof fixture>;
declare const admin: AdminPlatform<typeof fixture>;
declare const otherPlay: PlayPlatform<typeof other>;
declare const row: { partitionKey: string; rowKey: string };

void play.tables.scores.put(row);
void play.tables.levels.get('level', 'one');
void play.blobs.art.get('one.png');
void play.blobs.uploads.put('a.png', new Uint8Array(), 'image/png');
void admin.tables.levels.put(row);
void admin.tables.scores.list();
void admin.tables.notes.put(row);
void admin.queues.jobs.send({ noteId: 'n1' });
void admin.roster.list();
const hints: string | undefined = play.settings.HINTS_URL;
const maxLevels: number = admin.settings.MAX_LEVELS;
void otherPlay.tokens.cognitiveServices();
void playStore(play);
void adminStore(admin);

// @ts-expect-error a player app cannot write a content table; levels belong to the admin app.
void play.tables.levels.put(row);
// @ts-expect-error a player app cannot write a content container either.
void play.blobs.art.put('one.png', new Uint8Array(), 'image/png');
// @ts-expect-error the admin app reads scores but never writes a child's score.
void admin.tables.scores.put(row);
// @ts-expect-error nor a child's upload.
void admin.blobs.uploads.remove('a.png');
// @ts-expect-error an admin-private table gives the player app no handle at all.
void play.tables.notes;
// @ts-expect-error an admin-private queue is not the player app's either.
const playQueue: keyof typeof play.queues = 'jobs';
// @ts-expect-error the player store is built over play handles only, never admin ones.
void playStore(admin);
// @ts-expect-error the admin store is built over admin handles only, never play ones.
void adminStore(play);
// @ts-expect-error pictures is another game's table.
void play.tables.pictures;
// @ts-expect-error levels is this game's table, not the other game's.
void otherPlay.tables.levels;
// @ts-expect-error portal tables live in the portal account and are not reachable by name.
void play.tables['members'];
// @ts-expect-error an admin setting never reaches the player app.
void play.settings.MAX_LEVELS;
// @ts-expect-error storage is not an AzureService, so there is no storage token.
void otherPlay.tokens.storage;
// @ts-expect-error the platform carries no credential.
void play.credential;
// @ts-expect-error the platform carries no environment.
void play.env;
// @ts-expect-error an admin module's platform carries no Graph client.
void admin.graph;

defineGame({
	id: 'sneaky',
	title: 'Sneaky',
	summary: '',
	icon: 'icon.svg',
	storage: { tables: {}, containers: {}, queues: {} },
	play: {
		web: { kind: 'static' },
		settings: {},
		// @ts-expect-error a manifest cannot declare a storage service.
		services: ['storage'],
	},
});

defineGame({
	id: 'sharer',
	title: 'Sharer',
	summary: '',
	icon: 'icon.svg',
	storage: { tables: {}, containers: {}, queues: {} },
	play: { web: { kind: 'static' }, settings: {}, services: [] },
	// @ts-expect-error exports must be empty until the cross-game hub exists.
	exports: { scoreboard: 'v1' },
});

const billed = defineGame({
	id: 'billed',
	title: 'Billed',
	summary: '',
	icon: 'icon.svg',
	storage: { tables: {}, containers: {}, queues: {} },
	play: { web: { kind: 'static' }, settings: {}, services: [] },
	admin: { web: { kind: 'static' }, settings: {}, services: ['cognitiveServices'], ai: { words: 'Story words', picture: 'Pictures' } },
});
declare const billedAdmin: AdminPlatform<typeof billed>;
declare const billedPlay: PlayPlatform<typeof billed>;
declare const pictureTokens: ImageTokens;
const subject = { item: 'round-1', group: 'topic-1' };
const chat = { input: 800, cachedInput: 200, output: 500 };

void billedAdmin.usage.record({ area: 'words', model: 'gpt-5.4-mini', tokens: chat, subject });
void billedAdmin.usage.record({ area: 'picture', model: 'gpt-image-2', tokens: pictureTokens, subject });
void billedAdmin.usage.spend();
// @ts-expect-error a player app whose manifest declares no play.ai has no ledger.
void billedPlay.usage;

const reads = defineGame({
	id: 'reads',
	title: 'Reads',
	summary: '',
	icon: 'icon.svg',
	storage: { tables: { scores: 'play' }, containers: {}, queues: {} },
	play: { web: { kind: 'static' }, settings: { TIER: { kind: 'choice', values: ['F0', 'S1'] } }, services: ['cognitiveServices'], ai: { handwriting: 'Handwriting reading' } },
	admin: { web: { kind: 'static' }, settings: {}, services: [], ai: { words: 'Story words' } },
});
declare const readsPlay: PlayPlatform<typeof reads>;
declare const readsAdmin: AdminPlatform<typeof reads>;
const oneRead = { transactions: 1 };
const tier: 'F0' | 'S1' = readsPlay.settings.TIER;

void readsPlay.usage.record({ area: 'handwriting', model: 'azure-vision-read', tokens: oneRead, subject });
void readsPlay.usage.record({ area: 'handwriting', model: 'azure-vision-read-free', tokens: oneRead, subject });
// @ts-expect-error the player app's ledger is the host's, in its own account, and never a table handle a game can write.
void readsPlay.tables['aiusage'];
// @ts-expect-error nor can the player app reach the portal ledger the admin app writes.
void readsPlay.tables['aiusage'].put(row);
// @ts-expect-error a player app records only areas its play.ai declares, never the admin part's.
void readsPlay.usage.record({ area: 'words', model: 'gpt-5.4-mini', tokens: chat, subject });
// @ts-expect-error the admin part records only its admin.ai areas, never the player app's.
void readsAdmin.usage.record({ area: 'handwriting', model: 'azure-vision-read', tokens: oneRead, subject });
// @ts-expect-error a player app reports a count and never a price.
void readsPlay.usage.record({ area: 'handwriting', model: 'azure-vision-read', tokens: oneRead, subject, microUsd: 0 });
// @ts-expect-error a per-transaction model bills on transactions, never tokens.
void readsPlay.usage.record({ area: 'handwriting', model: 'azure-vision-read', tokens: chat, subject });
// @ts-expect-error a player app's ledger names no game, so it cannot write as, or read, another game's.
void readsPlay.usage.record({ area: 'handwriting', model: 'azure-vision-read', tokens: oneRead, subject, game: 'drawpad' });
// @ts-expect-error spend reads this game's ledger only, and takes no other game to read.
void readsPlay.usage.spend('drawpad');
// @ts-expect-error a choice setting is one of its values.
const wrongTier: 'F0' = readsPlay.settings.TIER;

defineGame({
	id: 'squatter',
	title: 'Squatter',
	summary: '',
	icon: 'icon.svg',
	// @ts-expect-error the host's ledger table name is reserved, so no manifest can declare it or own it.
	storage: { tables: { aiusage: 'admin' }, containers: {}, queues: {} },
	play: { web: { kind: 'static' }, settings: {}, services: [] },
});
// @ts-expect-error the ledger is a portal table, which no game reaches by name.
void billedAdmin.tables['aiusage'];
// @ts-expect-error an area must be one the manifest's admin.ai declares.
void billedAdmin.usage.record({ area: 'nope', model: 'gpt-5.4-mini', tokens: chat, subject });
// @ts-expect-error another game's area, such as drawpad's titles, is not this game's.
void billedAdmin.usage.record({ area: 'titles', model: 'gpt-5.4-mini', tokens: chat, subject });
// @ts-expect-error a game reports tokens and never a price; the host prices every call.
void billedAdmin.usage.record({ area: 'words', model: 'gpt-5.4-mini', tokens: chat, subject, microUsd: 1 });
// @ts-expect-error a chat model bills on chat tokens, never image tokens.
void billedAdmin.usage.record({ area: 'words', model: 'gpt-5.4-mini', tokens: pictureTokens, subject });
// @ts-expect-error a model with no price in the host's table cannot be recorded.
void billedAdmin.usage.record({ area: 'words', model: 'gpt-99', tokens: chat, subject });
// @ts-expect-error every model needs a price, so a model added to AiModel without one does not compile.
const unpriced: Rates = { 'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 } };
// @ts-expect-error a game that declares no AI areas cannot record any usage.
void admin.usage.record({ area: 'words', model: 'gpt-5.4-mini', tokens: chat, subject });

declare const caller: Caller;
// @ts-expect-error a games caller is a player; there is no role to check.
void caller.role;

const promote: PlayRoute = {
	name: 'promote',
	method: 'POST',
	path: 'promote',
	body: 'none',
	// @ts-expect-error a player route has no access level, so no route can be "admins only".
	access: 'admin',
	run: async () => ({ status: 204 }),
};

definePlayApi(fixture, () => ({
	routes: [],
	// @ts-expect-error a play worker may only consume a 'play' queue, and jobs is admin-private.
	workers: [{ queue: 'jobs', run: async () => {} }],
}));

declare const playDeps: PlayerAppDeps<typeof fixture>;
declare const portalStore: PortalStore;
declare const seen: Member;
// @ts-expect-error a player app reads portal tables and cannot write a profile; only the portal app can.
void playDeps.portal.setProfile(seen.userId, { displayName: 'x', timeZone: 'UTC' }, new Date());
// @ts-expect-error the portal app cannot write members; grants and revokes change only in the admin app.
void portalStore.putMember(seen);
// @ts-expect-error a member row carries no email, so a games-side app learns no child's email.
void seen.email;

declare const adminRows: AdminStore;
declare const adminToken: AdminToken;
declare const childAuth: Extract<Authentication, { readonly ok: true }>;
declare const session: AdminSession;
declare const elevation: Elevation;
declare const graph: GraphFor;

void openAdminSession(adminToken, adminRows);
void graph(elevation);
// @ts-expect-error a games4kids token is not an admin token, so a child's token never opens an admin session.
void openAdminSession(childAuth, adminRows);
// @ts-expect-error an admin session is minted only by openAdminSession.
const forgedSession: AdminSession = { admin: { objectId: adminToken.objectId, email: 'a@b' as Email }, token: adminToken };
// @ts-expect-error Graph needs an elevation; an everyday admin.console session never reaches it.
void graph(session);
// @ts-expect-error an elevation is minted only by elevate, from a token whose auth_time is fresh.
const forgedElevation: Elevation = { session, until: new Date() };

declare const telemetry: Telemetry;
declare const someUser: PortalUserId;
declare const someEmail: Email;
telemetry.setUser(someUser);
// @ts-expect-error an email is never the telemetry user.
telemetry.setUser(someEmail);

export { billed, forgedElevation, forgedSession, hints, maxLevels, other, playQueue, promote, reads, tier, unpriced, wrongTier };
