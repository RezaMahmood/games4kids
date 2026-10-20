import type { GameId, PortalUserId } from '@g4k/sdk';

/**
 * Sent by each site's shell at 100 percent. A game_session beat goes every 60 seconds while a game page is visible, so
 * play minutes per game are a count of beats. Admin pages send page views only. The user is the PortalUserId.
 */
export type ShellEvent =
	| { readonly name: 'page_view'; readonly site: 'games' | 'admin'; readonly game: GameId | 'portal'; readonly user: PortalUserId | null }
	| { readonly name: 'game_session'; readonly game: GameId; readonly user: PortalUserId; readonly sessionId: string };

export const BEAT_MS = 60_000;

export type Telemetry = { track(event: ShellEvent): void };

export const noTelemetry: Telemetry = { track() {} };

export type IngestionTarget = { readonly instrumentationKey: string; readonly endpoint: string };

/** `InstrumentationKey=...;IngestionEndpoint=https://...` to the pieces the track call needs. */
export function parseConnectionString(raw: string): IngestionTarget | null {
	const parts = new Map(raw.split(';').map((part) => part.split('=', 2) as [string, string | undefined]));
	const instrumentationKey = parts.get('InstrumentationKey');
	const endpoint = parts.get('IngestionEndpoint');
	return instrumentationKey && endpoint && URL.canParse(endpoint) ? { instrumentationKey, endpoint: endpoint.replace(/\/?$/, '/') } : null;
}

type Envelope = {
	readonly name: string;
	readonly time: string;
	readonly iKey: string;
	readonly tags: Readonly<Record<string, string>>;
	readonly data: { readonly baseType: string; readonly baseData: Readonly<Record<string, unknown>> };
};

export function envelopeFor(event: ShellEvent, target: IngestionTarget, page: string, now: Date): Envelope {
	const tags = { 'ai.cloud.role': event.name === 'page_view' && event.site === 'admin' ? 'g4k-admin-site' : 'g4k-games-site', ...(event.user ? { 'ai.user.id': event.user } : {}) };
	const common = { ver: 2, name: event.name, properties: { ...event } };
	const data =
		event.name === 'page_view'
			? { baseType: 'PageviewData', baseData: { ...common, url: page } }
			: { baseType: 'EventData', baseData: common };
	return { name: `Microsoft.ApplicationInsights.${target.instrumentationKey.replaceAll('-', '')}.${data.baseType === 'PageviewData' ? 'Pageview' : 'Event'}`, time: now.toISOString(), iKey: target.instrumentationKey, tags, data };
}

type SinkDeps = { readonly fetchImpl?: typeof fetch; readonly page?: () => string; readonly now?: () => Date };

/** Application Insights through its track endpoint with `game` on every event. A telemetry failure never reaches the page. */
export function createTelemetry(connectionString: string, deps: SinkDeps = {}): Telemetry {
	const target = parseConnectionString(connectionString);
	if (!target) return noTelemetry;
	const doFetch: typeof fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
	return {
		track(event) {
			const body = JSON.stringify([envelopeFor(event, target, deps.page?.() ?? location.href, (deps.now ?? (() => new Date()))())]);
			doFetch(`${target.endpoint}v2/track`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
		},
	};
}

export type Beats = { readonly interval: (run: () => void, ms: number) => () => void; readonly visible: () => boolean };

const browserBeats: Beats = {
	interval: (run, ms) => {
		const handle = setInterval(run, ms);
		return () => clearInterval(handle);
	},
	visible: () => document.visibilityState === 'visible',
};

/** One beat each minute while the page is visible. Returns the stop function. */
export function startGameSession(telemetry: Telemetry, game: GameId, user: PortalUserId, sessionId: string, beats: Beats = browserBeats): () => void {
	return beats.interval(() => {
		if (beats.visible()) telemetry.track({ name: 'game_session', game, user, sessionId });
	}, BEAT_MS);
}
