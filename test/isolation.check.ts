/**
 * Compile-time proof, ported from docs/sketch/isolation.check.ts for the code phase 1 builds: a games token means
 * "player" and nothing more, each table has one writer, Graph needs an elevation, and an elevation cannot be forged.
 * `tsc -b` passes only if every @ts-expect-error line really is an error. The shell and migration negatives arrive
 * with phases 2 and 9.
 */
import { defineGame, definePlayApi, type AdminPlatform, type Caller, type Email, type PlayPlatform, type PlayRoute, type PortalUserId } from '@g4k/sdk';
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

export { forgedElevation, forgedSession, hints, maxLevels, other, playQueue, promote };
