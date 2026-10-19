/**
 * @g4k/host's telemetry module. Every app and both sites send to one Application Insights resource, and the workbook
 * (infra/workbook.json) attributes each row to a game without a per-record envelope:
 *   player app rows      cloud_RoleName is func-g4k-<id>, because service.name defaults to the Function app name
 *   portal app rows      cloud_RoleName func-g4k-portal
 *   admin app rows       cloud_RoleName func-g4k-admin, and the function name is `<owner>-<name>` (adminFunctionName),
 *                        with HTTP routes under api/admin/g/<id>/ or api/admin/portal/
 *   page views, beats    the browser SDK, stamped with `game` by each site's shell (ShellEvent)
 * Code never chooses its own game. The user is a span attribute, the PortalUserId, never an email.
 */

import type { PortalUserId } from './identity';
import type { GameId } from './manifest';

/** packages/host/src/adapters/telemetry.ts implements it, the only importer of @opentelemetry/*. No sampling. */
export type Telemetry = {
	/** Sets the g4k.user attribute on the current request's spans. */
	setUser(user: PortalUserId): void;
	/** Sets http.route to the matched template, such as /api/g/drawpad/drawings/{id}. */
	setRoute(route: string): void;
	log(level: 'info' | 'warn' | 'error', line: string): void;
	exception(error: unknown): void;
};

/** drawpad + stencilJobs -> drawpad-stencilJobs. Game ids hold no hyphen, so the owner splits back in KQL. */
export function adminFunctionName(owner: GameId | 'portal', name: string): string {
	throw new Error('not implemented');
}

/**
 * Sent by each site's shell through the browser SDK at 100 percent. A game_session beat goes every 60 seconds while
 * a game page is visible, so play minutes per game are a count of beats. Admin pages send page views only.
 */
export type ShellEvent =
	| { readonly name: 'page_view'; readonly site: 'games' | 'admin'; readonly game: GameId | 'portal'; readonly user: PortalUserId | null }
	| { readonly name: 'game_session'; readonly game: GameId; readonly user: PortalUserId; readonly sessionId: string };
