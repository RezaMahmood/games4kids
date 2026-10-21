import type { GameId, PortalUserId } from '@g4k/sdk';

type Site = 'games' | 'admin';

/** One browser fault as App Insights stores it. `status` and `code` come from an ApiFailure. */
export type ErrorReport = { readonly type: string; readonly message: string; readonly stack: string; readonly status?: number; readonly code?: string };

/**
 * Sent by each site's shell at 100 percent. A game_session beat goes every 60 seconds while a game page is visible, so
 * play minutes per game are a count of beats. Admin pages send page views and exceptions only. The user is the PortalUserId.
 */
export type ShellEvent =
	| { readonly name: 'page_view'; readonly site: Site; readonly game: GameId | 'portal'; readonly user: PortalUserId | null }
	| { readonly name: 'game_session'; readonly game: GameId; readonly user: PortalUserId; readonly sessionId: string }
	| { readonly name: 'exception'; readonly site: Site; readonly game: GameId | 'portal' | null; readonly user: PortalUserId | null; readonly error: ErrorReport };

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

function dataFor(event: ShellEvent, page: string): Envelope['data'] {
	switch (event.name) {
		case 'page_view':
			return { baseType: 'PageviewData', baseData: { ver: 2, name: event.name, properties: { ...event }, url: page } };
		case 'game_session':
			return { baseType: 'EventData', baseData: { ver: 2, name: event.name, properties: { ...event } } };
		case 'exception': {
			const { type, message, stack, status, code } = event.error;
			return {
				baseType: 'ExceptionData',
				baseData: {
					ver: 2,
					exceptions: [{ typeName: type, message, hasFullStack: stack !== '', stack }],
					severityLevel: 3,
					properties: { site: event.site, game: event.game ?? '', ...(status === undefined ? {} : { status: String(status) }), ...(code ? { code } : {}), page },
				},
			};
		}
	}
}

const ITEM = { PageviewData: 'Pageview', EventData: 'Event', ExceptionData: 'Exception' } as const;

export function envelopeFor(event: ShellEvent, target: IngestionTarget, page: string, now: Date): Envelope {
	const tags = { 'ai.cloud.role': 'site' in event && event.site === 'admin' ? 'g4k-admin-site' : 'g4k-games-site', ...(event.user ? { 'ai.user.id': event.user } : {}) };
	const data = dataFor(event, page);
	return { name: `Microsoft.ApplicationInsights.${target.instrumentationKey.replaceAll('-', '')}.${ITEM[data.baseType as keyof typeof ITEM]}`, time: now.toISOString(), iKey: target.instrumentationKey, tags, data };
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

type Where = { readonly site: Site; readonly game: GameId | 'portal' | null; readonly user: PortalUserId | null };

function describe(error: unknown): ErrorReport {
	const thrown = error instanceof Error ? error : new Error(String(error));
	const { status, code } = thrown as { status?: unknown; code?: unknown };
	return {
		type: thrown.name,
		message: thrown.message,
		stack: thrown.stack ?? '',
		...(typeof status === 'number' ? { status } : {}),
		...(typeof code === 'string' ? { code } : {}),
	};
}

/** An ApiFailure under 500 is the server's answer, such as forbidden or a form problem, so it is not a fault. */
const isAnswer = (error: unknown) => typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number' && (error as { status: number }).status < 500;

const HELD = 20;

export type Reporter = {
	/** Sends a fault once, however many catches pass it on. Before reportTo, up to 20 wait. */
	report(error: unknown): void;
	/** Where faults go from now on. Called again once the user is known. */
	reportTo(telemetry: Telemetry, where: Where): void;
	/** Reports whatever no catch handled on this page. */
	listen(page: EventTarget): void;
};

export function createReporter(): Reporter {
	let send: ((error: unknown) => void) | null = null;
	const held: unknown[] = [];
	const sent = new WeakSet<object>();
	const listening = new WeakSet<EventTarget>();
	const report = (error: unknown) => {
		if (isAnswer(error)) return;
		if (typeof error === 'object' && error !== null) {
			if (sent.has(error)) return;
			sent.add(error);
		}
		if (send) send(error);
		else if (held.length < HELD) held.push(error);
	};
	return {
		report,
		reportTo(telemetry, where) {
			send = (error) => telemetry.track({ name: 'exception', ...where, error: describe(error) });
			held.splice(0).forEach(send);
		},
		listen(page) {
			if (listening.has(page)) return;
			listening.add(page);
			page.addEventListener('error', (event) => report((event as ErrorEvent).error ?? new Error((event as ErrorEvent).message)));
			page.addEventListener('unhandledrejection', (event) => report((event as PromiseRejectionEvent).reason));
		},
	};
}

/** The page's one reporter, shared by the shell, the API client and any page that catches an error it shows. */
export const { report, reportTo, listen } = createReporter();
