/**
 * test/conformance.ts. test/conformance.test.ts runs both suites once per entry in dev/generated/games.ts, so a new
 * game gets them without writing a test. Each builds the real app over memory storage keyed by account, a memory
 * portal and the fake IdP, and drives app.handle. A spy wraps each handler, so "refused" means `run` never ran.
 *
 * They run in every pull request: a change to packages/*, apps/games/shell or apps/admin/shell runs every game's.
 *
 * Player suite (createPlayerApp):
 *   - 401 with no token, with an untrusted issuer, and with a games4kids-admin token
 *   - 403 not_invited for an unknown identity and for a revoked member; no_profile; not_entitled without the game
 *   - GET session answers the Caller for a granted player
 *   - every path stays under /api/g/<id>/; names and method+path pairs are unique
 *   - storage: the memory account saw this game's account and no other, and no write reached an 'admin' or
 *     'admin-private' name
 *   - every error body parses as ApiError; replies carry no CORS header; createPlayApi does no I/O
 *
 * Admin suite (the module mounted in createAdminApp):
 *   - 401 with a games4kids token, including one for a member whose games include this one
 *   - 403 for a games4kids-admin token whose oid has no admins row
 *   - every path stays under /api/admin/g/<id>/ and every function name is adminFunctionName(id, name)
 *   - no write reached a 'play' name; no handler received a Graph client
 */

import type { CreateAdminApi, CreatePlayApi } from './host';
import type { GameManifest } from './manifest';

export function runPlayConformance<M extends GameManifest>(manifest: M, createPlayApi: CreatePlayApi<M>): void {
	throw new Error('not implemented');
}

export function runAdminConformance<M extends GameManifest>(manifest: M, createAdminApi: CreateAdminApi<M>): void {
	throw new Error('not implemented');
}
