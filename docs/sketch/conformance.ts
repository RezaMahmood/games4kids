/**
 * test/conformance.ts. It needs createGameApp, so it lives with the tests, not in @g4k/sdk. test/conformance.test.ts
 * runs it once per entry in dev/generated/games.ts, so a new game gets the suite without writing a test.
 *
 * It builds the game's real app (createGameApp) over memory storage, a memory PortalReader and the fake IdP's
 * signing keys, and drives app.handle. The handler under test is wrapped in a spy, so "refused" means `run` never ran.
 *
 * When it runs:
 *   - a game's pipeline, before it publishes that game's app artifact
 *   - every pull request that changes packages/sdk, packages/host or shell/: every game's `tsc -b` and conformance
 *     run against the changed packages. Nothing deploys. A change released as a minor that fails any game is a major.
 *
 * Checks:
 *   - every route answers 401 unauthenticated without a token and with a token from an untrusted issuer
 *   - every route answers 403 not_claimed for a verified identity with no identities row, and writes no portal table
 *   - every route answers 403 not_invited for a claimed identity with no active member row, and for a revoked member
 *   - every route answers 403 not_entitled for an active member with a profile and no grant for this game
 *   - every route above the bottom rung answers 403 forbidden for a member one rung lower
 *   - route names and method+path pairs are unique; every path stays under /api/g/<id>/
 *   - the platform exposes exactly the declared tables, containers and queues, and the memory storage, keyed by
 *     account, saw this game's account (accountName(id)) and no other during the suite
 *   - every record the in-memory Telemetry sink received during the suite has game equal to this game's id, and
 *     every route and worker is registered under functionName(id, name)
 *   - GET health answers AppHealth with this game's id, the build's sha and the contract it was built against
 *   - every reply carries Access-Control-Allow-Origin equal to appOrigin and no other CORS header value
 *   - every error body parses as ApiError
 *   - createGameApi does no I/O: the memory storage records zero calls during startup
 */

import type { CreateGameApi } from './host';
import type { GameManifest } from './manifest';

/** Registers node:test cases. The access checks run before body parsing, so no sample bodies are needed. */
export function runGameConformance<M extends GameManifest>(manifest: M, createGameApi: CreateGameApi<M>): void {
	throw new Error('not implemented');
}
