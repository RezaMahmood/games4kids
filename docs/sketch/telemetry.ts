/**
 * host/src/telemetry.ts. Cost and usage by game: every record the host, the admin app and the shell send to the
 * one Application Insights resource names the game it belongs to, so the "Cost and usage by game" workbook
 * (infra/workbook.json) can group by it. Games never see this module; the host binds the envelope before `run`.
 *
 * Who writes which row:
 *   request and worker-run rows   the Functions host, named <owner>_<route> by registerWithFunctions (functionName)
 *   dependency, exception, log    the worker, inside Telemetry.within, stamped by a span processor
 *   page view, game_session       the shell, stamped by a telemetry initializer
 */

import type { PortalUserId } from './identity';
import type { GameId } from './manifest';

/** Who a row is billed to. 'portal' covers /api/portal/*, the admin app and the portal pages. */
export type TelemetryOwner = GameId | 'portal';

/**
 * Required on every host and admin-app record. `user` is the PortalUserId, a random UUID that means nothing
 * outside the portal tables, never an email; null before admission (a 401) and on worker runs.
 */
export type GameTelemetry = {
	readonly game: TelemetryOwner;
	/** Route or worker name, unique within the owner. */
	readonly route: string;
	readonly user: PortalUserId | null;
};

/**
 * host/src/adapters/telemetry.ts implements it, the only importer of @opentelemetry/*. Every method takes the
 * envelope, so a record without `game` does not compile. There is no sampling: an always-on sampler, and
 * host.json in telemetryMode OpenTelemetry, where its sampling settings no longer apply.
 */
export type Telemetry = {
	/** Runs `work` with the envelope as context; every span and log record started inside carries it. */
	within<T>(envelope: GameTelemetry, work: () => Promise<T>): Promise<T>;
	log(envelope: GameTelemetry, level: 'info' | 'warn' | 'error', line: string): void;
	exception(envelope: GameTelemetry, error: unknown): void;
};

/** drawpad + createDrawing -> drawpad_createDrawing. Game ids hold no underscore, so the owner parses back. */
export function functionName(owner: TelemetryOwner, route: string): string {
	throw new Error('not implemented');
}

/**
 * Sent by /shell/v1.js through the Application Insights browser SDK at 100 percent. A game_session beat goes
 * every 60 seconds while a game page is visible, so play minutes per game are a count of beats.
 */
export type ShellEvent =
	| { readonly name: 'page_view'; readonly game: TelemetryOwner; readonly user: PortalUserId | null }
	| { readonly name: 'game_session'; readonly game: GameId; readonly user: PortalUserId; readonly sessionId: string };

/**
 * The workbook's allocation, as data. KQL over request and worker-run rows yields DurationShare per UTC day,
 * where billedMs rounds each execution up to Flex's 1,000 ms minimum and then to 100 ms. The Cost Management
 * step yields HostCost for func-g4k-host. A merge on `date` yields AllocatedCost = costUsd * share: an estimate,
 * because concurrent executions bill once, cold starts bill to no request, and executions split by duration.
 */
export type DurationShare = { readonly date: string; readonly game: TelemetryOwner; readonly billedMs: number; readonly share: number };
export type HostCost = { readonly date: string; readonly costUsd: number };
export type AllocatedCost = { readonly date: string; readonly game: TelemetryOwner; readonly costUsd: number };
