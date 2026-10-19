/**
 * Compile-time proof of the claims the architecture rests on: a games token means "player" and nothing more, each
 * table has one writer, Graph needs an elevation, an elevation cannot be forged, and the migration guards hold.
 * `tsc --noEmit` passes only if every @ts-expect-error line really is an error, so the negatives are checked too.
 */
import { graphAs, openAdminSession, syncEntra, type AdminSession, type AdminStore, type AdminToken, type ClientAssertion, type Elevation, type OboGraph } from './admin';
import { definePlayApi, type AdminPlatform, type PlayPlatform, type PlayRoute, type PlayerAppDeps } from './host';
import type { Authentication, Caller, Email, Member, PortalStore, PortalUserId } from './identity';
import { defineGame } from './manifest';
import { migratePlayerData, parseConfirmation, type NewAccounts, type OldAccounts, type PlayerDataMapping } from './migrate';
import type { AdminGameSession, AdminPortalSession, GameSession, GamesSiteConfig } from './shell';
import type { Telemetry } from './telemetry';
import { adminStore, playStore } from './examples/drawpad/data';
import type drawpad from './examples/drawpad/manifest';
import type letterjoin from './examples/letterjoin/manifest';
import letterjoinManifest from './examples/letterjoin/manifest';

declare const lj: PlayPlatform<typeof letterjoin>;
declare const dp: PlayPlatform<typeof drawpad>;
declare const dpAdmin: AdminPlatform<typeof drawpad>;
declare const ljAdmin: AdminPlatform<typeof letterjoin>;
declare const row: { partitionKey: string; rowKey: string };

void dp.tables.drawings.put(row);
void dp.tables.pictures.get('picture', 'p1');
void dp.blobs.pictures.get('p1/outline.png');
void dpAdmin.tables.pictures.put(row);
void dpAdmin.tables.drawings.list();
void dpAdmin.queues['stencil-jobs'].send({ jobId: 'j1' });
void ljAdmin.tables.reviews.put(row);
const vision: string | undefined = lj.settings.VISION_ENDPOINT;
const foundry: string = dpAdmin.settings.FOUNDRY_ENDPOINT;
void lj.tokens.cognitiveServices();
void playStore(dp);
void adminStore(dpAdmin);

// @ts-expect-error a player app cannot write a content table; pictures belong to the admin app.
void dp.tables.pictures.put(row);
// @ts-expect-error a player app cannot write a content container either.
void dp.blobs.pictures.put('p1/outline.png', new Uint8Array(), 'image/png');
// @ts-expect-error the admin app reads drawings for the gallery but never writes a child's drawing.
void dpAdmin.tables.drawings.put(row);
// @ts-expect-error the AI job table is admin-private, so the player app has no handle on it at all.
void dp.tables.jobs;
// @ts-expect-error the job queue is admin-private too; the worker runs in the admin app.
const playQueue: keyof typeof dp.queues = 'stencil-jobs';
// @ts-expect-error review state is admin-private, so a child's app cannot read or write a review.
void lj.tables.reviews;
// @ts-expect-error the player store is built over play handles only, never admin ones.
void playStore(dpAdmin);
// @ts-expect-error pictures is drawpad's table, not letterjoin's.
void lj.tables.pictures;
// @ts-expect-error portal tables live in the portal account and are not reachable by name.
void lj.tables['members'];
// @ts-expect-error Foundry is the admin part's setting; the player app never sees it.
void dp.settings.FOUNDRY_ENDPOINT;
// @ts-expect-error storage is not an AzureService, so there is no storage token.
void lj.tokens.storage;
// @ts-expect-error the platform carries no credential.
void lj.credential;
// @ts-expect-error the platform carries no environment.
void lj.env;

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

definePlayApi(letterjoinManifest, () => ({
	routes: [],
	// @ts-expect-error letterjoin declared no queue, and a play worker may only consume a 'play' queue.
	workers: [{ queue: 'stencil-jobs', run: async () => {} }],
}));

declare const game: GameSession;
declare const gamesConfig: GamesSiteConfig;
// @ts-expect-error a game page's session has no role.
void game.me.role;
// @ts-expect-error the games site config has no admin scope, so no page on the games origin can request an admin token.
void gamesConfig.elevateScope;
// @ts-expect-error nor the admin API origin.
void gamesConfig.adminApiOrigin;

declare const adminGame: AdminGameSession;
declare const adminPortal: AdminPortalSession;
void adminPortal.elevated(async (api) => api.get('portal/entra'));
// @ts-expect-error a game's admin page never elevates; only the members and Entra pages can.
void adminGame.elevated(async () => 0);

declare const playDeps: PlayerAppDeps<typeof drawpad>;
declare const portalStore: PortalStore;
declare const seen: Member;
// @ts-expect-error a player app reads portal tables and cannot write a profile; only the portal app can.
void playDeps.portal.setProfile(seen.userId, { displayName: 'x', timeZone: 'UTC' });
// @ts-expect-error the portal app cannot write members; grants and revokes change only in the admin app.
void portalStore.putMember(seen);
// @ts-expect-error a member row carries no email, so a games-side app learns no child's email.
void seen.email;

declare const adminStoreRows: AdminStore;
declare const adminToken: AdminToken;
declare const childAuth: Extract<Authentication, { readonly ok: true }>;
declare const session: AdminSession;
declare const elevation: Elevation;
declare const clientAssertion: ClientAssertion;
declare const graph: OboGraph;

void openAdminSession(adminToken, adminStoreRows);
void graphAs(elevation, clientAssertion, 'tenant');
void syncEntra(graph, adminStoreRows, null, 'https://games/');
// @ts-expect-error a games4kids token is not an admin token, so a child's token never opens an admin session.
void openAdminSession(childAuth, adminStoreRows);
// @ts-expect-error an admin session is minted only by openAdminSession.
const forgedSession: AdminSession = { admin: { objectId: adminToken.objectId, email: 'a@b' as Email }, token: adminToken };
// @ts-expect-error OBO needs an elevation; an everyday admin.console session never reaches Graph.
void graphAs(session, clientAssertion, 'tenant');
// @ts-expect-error an elevation is minted only by elevate, from a token whose auth_time is fresh.
const forgedElevation: Elevation = { session, until: new Date() };

declare const telemetry: Telemetry;
declare const someUser: PortalUserId;
declare const someEmail: Email;
telemetry.setUser(someUser);
// @ts-expect-error an email is never the telemetry user.
telemetry.setUser(someEmail);

declare const old: OldAccounts;
declare const fresh: NewAccounts;
declare const mapping: PlayerDataMapping;
declare const argv: readonly string[];

void migratePlayerData({ mode: 'dry-run', mapping }, old, fresh);
const confirmation = parseConfirmation(argv);
if (confirmation) void migratePlayerData({ mode: 'apply', mapping, confirmation }, old, fresh);
// @ts-expect-error applying player data needs the confirmation that only --confirm-player-data mints.
void migratePlayerData({ mode: 'apply', mapping }, old, fresh);
// @ts-expect-error a plain string is not a confirmation.
void migratePlayerData({ mode: 'apply', mapping, confirmation: 'confirm-player-data' }, old, fresh);
// @ts-expect-error the old accounts are read-only, so a table handle has no write.
void old.drawpad.tables.drawings?.insertIfAbsent({ partitionKey: 'p', rowKey: 'r' });
// @ts-expect-error each game migrates into its own account; there is no shared target.
void fresh.table('drawings');

export { forgedElevation, forgedSession, foundry, playQueue, promote, vision };
