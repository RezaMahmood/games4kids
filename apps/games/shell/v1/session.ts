import type { CatalogEntry, GameId, PortalUserId, Profile } from '@g4k/sdk';
import { ApiFailure, createApiClient, type ApiClient } from '../../../shared/api-client.ts';
import { showScreen, stylesheet, type ScreenAction } from '../../../shared/dom.ts';
import { asGameId } from '../../../shared/ids.ts';
import { createTelemetry, listen, report, reportTo, startGameSession, type Telemetry } from '../../../shared/telemetry.ts';
import { startGamesAuth, type SignedIn } from './auth.ts';
import { loadCatalog, loadGamesConfig, type GamesSiteConfig } from './config.ts';
import { parseCaller, parseMe } from './me.ts';
import { mountPortalBar, type BarState } from './portal-bar.ts';
import { asRefusal, onRefusal } from './refusal.ts';
import { createGameStorage, type GameStorage } from './storage.ts';

export type GameSession = {
	readonly me: { readonly userId: PortalUserId; readonly profile: Profile };
	readonly api: ApiClient;
	readonly storage: GameStorage;
	/** Shows a name the child just changed in the portal bar, with no reload. */
	renamed(displayName: string): void;
	signOut(): Promise<void>;
	/** Signs out and asks Entra for an account picker. For the family iPad passed between children. */
	switchAccount(): Promise<void>;
};

/** What a portal page (home) gets: the same session, bound to the portal app, plus a card for each game switched on for this child. A paused game keeps its card. `canRenameToday` is the server's word on the once-a-day rename. */
export type PortalSession = GameSession & { readonly games: readonly (CatalogEntry & { readonly paused: boolean })[]; readonly canRenameToday: boolean };

/** /welcome/ runs for a member who has no profile yet, which `enter` would send back here. */
export type WelcomeSession = { readonly api: ApiClient; signOut(): Promise<void> };

const never = (): Promise<never> => new Promise(() => {});

export const welcomeUrl = (returnTo: string) => `/welcome/?return=${encodeURIComponent(returnTo)}`;

const toGames: ScreenAction = { label: 'Back to my games', run: () => location.assign('/') };

/** `extra` sits between Try again and Sign out: on a game page, the way back to the games list. */
function failed(error: unknown, signOut: () => Promise<void>, ...extra: readonly ScreenAction[]): Promise<never> {
	if (error !== null) report(error);
	showScreen('Something went wrong', error instanceof ApiFailure ? error.message : 'We could not reach the games. Try again in a moment.', [
		{ label: 'Try again', run: () => location.reload() },
		...extra,
		{ label: 'Sign out', run: signOut },
	]);
	return never();
}

/** A refusal the child can do nothing about on this page: a screen, or the welcome page, and the promise never settles. */
function refused(error: ApiFailure, signedIn: SignedIn): Promise<never> | null {
	const refusal = asRefusal(error.code);
	if (!refusal || onRefusal(refusal) !== 'screen') return null;
	switch (refusal) {
		case 'not_invited':
			showScreen('Ask your grown-up to invite you', 'This sign-in is not on the list yet.', [{ label: 'Sign out', run: signedIn.signOut }]);
			return never();
		case 'no_profile':
			location.replace(welcomeUrl(`${location.pathname}${location.search}`));
			return never();
		case 'not_entitled':
			showScreen('This game is not switched on for you', 'Ask your grown-up to switch it on.', [
				toGames,
				{ label: 'Sign out', run: signedIn.signOut },
			]);
			return never();
		case 'game_paused':
			showScreen('This game is having a rest', 'Your grown-up has paused it for now. Try again later.', [
				toGames,
				{ label: 'Sign out', run: signedIn.signOut },
			]);
			return never();
		default:
			return null;
	}
}

type Context = { readonly config: GamesSiteConfig; readonly signedIn: SignedIn; readonly telemetry: Telemetry };

async function start(game: GameId | 'portal' | null): Promise<Context> {
	listen(window);
	const config = await loadGamesConfig();
	const telemetry = createTelemetry(config.telemetryConnectionString);
	reportTo(telemetry, { site: 'games', game, user: null });
	stylesheet('/shared/tokens.css');
	stylesheet('/shared/shell.css');
	const auth = await startGamesAuth(config);
	if (!auth.session) return auth.signIn();
	return { config, signedIn: auth.session, telemetry };
}

function session(ctx: Context, api: ApiClient, who: { readonly userId: PortalUserId; readonly profile: Profile }, game: GameId | 'portal', place: BarState['place']): GameSession {
	const { signedIn, telemetry } = ctx;
	const showBar = (displayName: string) => mountPortalBar({ place, displayName, switchPlayer: () => void signedIn.switchAccount(), signOut: () => void signedIn.signOut() });
	showBar(who.profile.displayName);
	reportTo(telemetry, { site: 'games', game, user: who.userId });
	telemetry.track({ name: 'page_view', site: 'games', game, user: who.userId });
	if (game !== 'portal') startGameSession(telemetry, game, who.userId, crypto.randomUUID());
	return { me: who, api, storage: createGameStorage(localStorage, game, who.userId), renamed: showBar, signOut: signedIn.signOut, switchAccount: signedIn.switchAccount };
}

/**
 * The games site's one entry. `game: null` is a portal page: its api is the portal app and it calls GET me. A game
 * page's api is that game's own app and it calls GET session, so only that app wakes. It resolves only for a player
 * of this game. Every other state is a screen or a redirect, and the promise never settles:
 *   signed out     loginRedirect, back to this page
 *   not_invited    "Ask your grown-up to invite you", with a sign-out button
 *   no_profile     location = /welcome/?return=<this page>
 *   not_entitled   "This game is not switched on for you"
 *   game_paused    "This game is having a rest"
 */
export function enter(options: { readonly game: null; readonly place?: BarState['place'] }): Promise<PortalSession>;
export function enter(options: { readonly game: string }): Promise<GameSession>;
export async function enter(options: { readonly game: string | null; readonly place?: BarState['place'] }): Promise<GameSession | PortalSession> {
	const ctx = await start(options.game === null ? 'portal' : asGameId(options.game));
	const { config, signedIn } = ctx;

	if (options.game === null) {
		const api = createApiClient({ baseUrl: `${config.portalApiOrigin}/api/portal`, tokens: signedIn.tokens });
		const me = parseMe(await api.get('me').catch((error: unknown) => failed(error, signedIn.signOut)));
		if (!me) return failed(null, signedIn.signOut);
		switch (me.state) {
			case 'not-invited':
				showScreen('Ask your grown-up to invite you', 'This sign-in is not on the list yet.', [{ label: 'Sign out', run: signedIn.signOut }]);
				return never();
			case 'no-profile':
				location.replace(welcomeUrl('/'));
				return never();
			case 'active': {
				const catalog = await loadCatalog();
				const games = catalog.flatMap((entry) => me.games.filter((game) => game.id === entry.id).map(({ paused }) => ({ ...entry, paused })));
				return { ...session(ctx, api, me, 'portal', options.place ?? { kind: 'home' }), games, canRenameToday: me.canRenameToday };
			}
		}
	}

	const id = asGameId(options.game);
	const entry = id && (await loadCatalog()).find((candidate) => candidate.id === id);
	if (!entry) {
		showScreen('That game is not here', 'Pick a game from your home page.', [toGames]);
		return never();
	}
	const api = createApiClient({ baseUrl: `${entry.apiBaseUrl}/api/g/${entry.id}`, tokens: signedIn.tokens });
	try {
		const caller = parseCaller(await api.get('session'));
		if (!caller) return failed(null, signedIn.signOut, toGames);
		return session(ctx, api, caller, entry.id, { kind: 'game', title: entry.title });
	} catch (error) {
		return (error instanceof ApiFailure && refused(error, signedIn)) || failed(error, signedIn.signOut, toGames);
	}
}

/** The welcome page's entry: signed in, any invited member. A member who is not invited gets the same screen as anywhere else. */
export async function enterWelcome(): Promise<WelcomeSession> {
	const ctx = await start('portal');
	const api = createApiClient({ baseUrl: `${ctx.config.portalApiOrigin}/api/portal`, tokens: ctx.signedIn.tokens });
	const me = parseMe(await api.get('me').catch((error: unknown) => failed(error, ctx.signedIn.signOut)));
	if (me?.state === 'not-invited') {
		showScreen('Ask your grown-up to invite you', 'This sign-in is not on the list yet.', [{ label: 'Sign out', run: ctx.signedIn.signOut }]);
		return never();
	}
	if (me?.state === 'active') {
		location.replace('/');
		return never();
	}
	return { api, signOut: ctx.signedIn.signOut };
}
