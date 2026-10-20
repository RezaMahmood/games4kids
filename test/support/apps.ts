import { adminModule, createAdminApp, createPlayerApp, createPortalApp, type Accounts, type GraphFor } from '@g4k/host';
import fixture from '../fixtures/games/fixture/manifest.ts';
import { createAdminApi } from '../fixtures/games/fixture/admin/api/index.ts';
import { createPlayApi } from '../fixtures/games/fixture/play/api/index.ts';
import { fakeGraph } from './graph.ts';
import { gameId } from './ids.ts';
import type { FakeIdp } from './idp.ts';
import type { World } from './world.ts';

const tokens = async () => 'token';

/** The three apps over one world, as func-g4k-fixture, func-g4k-portal and func-g4k-admin. */
export function fixtureApps(w: World, idp: FakeIdp, graph: GraphFor = () => fakeGraph().graph, accounts: Accounts = w.accounts) {
	const common = { telemetry: w.telemetry, now: w.now };
	return {
		player: createPlayerApp({ ...common, issuers: [idp.games], manifest: fixture, create: createPlayApi, portal: w.reader, accounts, tokens, env: {} }),
		portal: createPortalApp({ ...common, issuers: [idp.games], portal: w.portal }),
		admin: createAdminApp({
			...common,
			issuer: idp.admin,
			store: w.admin,
			graph,
			games: [gameId('fixture')],
			modules: [adminModule(fixture, createAdminApi)],
			accounts,
			tokens,
			env: {},
			gamesOrigin: 'https://games.example',
		}),
	};
}
