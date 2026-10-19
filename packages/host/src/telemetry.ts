import type { GameId, PortalUserId } from '@g4k/sdk';

/** The OpenTelemetry adapter that implements this for Application Insights lands with the deploy phase. */
export type Telemetry = {
	/** Sets the g4k.user attribute on the current request's spans. */
	setUser(user: PortalUserId): void;
	log(level: 'info' | 'warn' | 'error', line: string): void;
	exception(error: unknown): void;
};

/** drawpad + stencilJobs -> drawpad-stencilJobs. Game ids hold no hyphen, so the owner splits back in KQL. */
export function adminFunctionName(owner: GameId | 'portal', name: string): string {
	return `${owner}-${name}`;
}
