import { HttpError, parseEmail, type Brand, type Email, type EntraObjectId, type GameId, type PortalUserId, type Profile } from '@g4k/sdk';
import type { GameGrant, Member } from './identity.ts';
import { verifyBearer, type TokenRejection, type TrustedIssuer } from './token.ts';

export type AdminScope = 'admin.console' | 'admin.elevate';

const ADMIN_SCOPES: readonly AdminScope[] = ['admin.console', 'admin.elevate'];

/** The admin's bearer token after verifyAdminToken checked it. Minted only there. It is the OBO `assertion`. */
export type AdminAssertion = Brand<string, 'AdminAssertion'>;

export type AdminToken = {
	readonly objectId: EntraObjectId;
	readonly scopes: readonly AdminScope[];
	/** The auth_time claim: when the person last entered credentials. null when absent, which never elevates. */
	readonly authTime: Date | null;
	readonly assertion: AdminAssertion;
};

export type AdminAuthentication = { readonly ok: true; readonly token: AdminToken } | TokenRejection;

/** verifyGamesToken's checks, with aud games4kids-admin and scp containing admin.console or admin.elevate. */
export async function verifyAdminToken(issuer: TrustedIssuer, authorization: string | null): Promise<AdminAuthentication> {
	const verified = await verifyBearer([issuer], authorization, ADMIN_SCOPES);
	if (!verified.ok) return verified;
	const authTime = verified.claims['auth_time'];
	return {
		ok: true,
		token: {
			objectId: verified.objectId,
			scopes: ADMIN_SCOPES.filter((scope) => verified.scopes.includes(scope)),
			authTime: typeof authTime === 'number' ? new Date(authTime * 1000) : null,
			assertion: verified.raw as AdminAssertion,
		},
	};
}

/** One admins row, written only by tools/bootstrap.mjs on the Mac. */
export type AdminRow = { readonly objectId: EntraObjectId; readonly email: Email };

/** One row of the members screen. `objectId` comes from the identities row, null until the first sync records it. */
export type MemberView = { readonly member: Member; readonly email: Email; readonly objectId: EntraObjectId | null; readonly profile: Profile | null };

/** The admin app's view of the portal tables: writes members, emails and identities; reads profiles and admins. */
export type AdminStore = {
	admin(objectId: EntraObjectId): Promise<AdminRow | undefined>;
	member(userId: PortalUserId): Promise<Member | undefined>;
	/** emails insert-if-absent with a fresh id; on conflict the existing userId, so a re-invite keeps the child's history. */
	userIdFor(email: Email): Promise<PortalUserId>;
	putMember(member: Member): Promise<void>;
	/** identities insert-if-absent, `entra|<objectId>` -> userId. */
	recordIdentity(objectId: EntraObjectId, userId: PortalUserId): Promise<void>;
	/** identities delete of `entra|<objectId>`, so that account signs in as no one. A missing row counts as done. */
	forgetIdentity(objectId: EntraObjectId): Promise<void>;
	rows(): Promise<readonly MemberView[]>;
	paused(): Promise<ReadonlySet<GameId>>;
	/** Pausing puts the game row and resuming deletes it, so a repeat of either changes nothing. */
	setPaused(game: GameId, paused: boolean): Promise<void>;
};

/** A request from an account assigned to games4kids-admin that has an admins row. Minted only by openAdminSession. */
export type AdminSession = Brand<{ readonly admin: AdminRow; readonly token: AdminToken }, 'AdminSession'>;

export async function openAdminSession(token: AdminToken, store: AdminStore): Promise<AdminSession | 'forbidden'> {
	const admin = await store.admin(token.objectId);
	return admin ? ({ admin, token } as AdminSession) : 'forbidden';
}

/** Ten minutes from the sign-in that minted the token. One Entra task fits; the next task signs in again. */
export const ELEVATION_MAX_AGE_SECONDS = 600;

/** Tolerates an auth_time slightly ahead of this host's clock, the same tolerance as exp and iat. */
const CLOCK_SKEW_SECONDS = 60;

/** Proof that this admin entered credentials moments ago. Minted only by elevate. */
export type Elevation = Brand<{ readonly session: AdminSession; readonly until: Date }, 'Elevation'>;

export type StepUp = { readonly kind: 'step_up_required'; readonly maxAgeSeconds: number };

/** Pure. An Elevation when the token has scope admin.elevate and authTime is at most ELEVATION_MAX_AGE_SECONDS old. */
export function elevate(session: AdminSession, now: Date): Elevation | StepUp {
	const { authTime, scopes } = session.token;
	const stepUp: StepUp = { kind: 'step_up_required', maxAgeSeconds: ELEVATION_MAX_AGE_SECONDS };
	if (!scopes.includes('admin.elevate') || !authTime) return stepUp;
	const ageSeconds = (now.getTime() - authTime.getTime()) / 1000;
	if (ageSeconds > ELEVATION_MAX_AGE_SECONDS || ageSeconds < -CLOCK_SKEW_SECONDS) return stepUp;
	return { session, until: new Date(authTime.getTime() + ELEVATION_MAX_AGE_SECONDS * 1000) } as Elevation;
}

export type MemberRequest = { readonly email: Email; readonly games: GameGrant };

export type AccessChange = Pick<Member, 'state' | 'games'>;

type Parsed<T> = T | { readonly problems: readonly string[] };

function fieldOf(raw: unknown, name: string): unknown {
	return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[name] : undefined;
}

function parseGrant(raw: unknown, known: readonly GameId[], problems: string[]): GameGrant {
	const kind = fieldOf(raw, 'kind');
	const ids = fieldOf(raw, 'ids');
	if (kind === 'all' && ids === undefined) return { kind: 'all' };
	if (kind !== 'some' || !Array.isArray(ids)) {
		problems.push('games must be { kind: "all" } or { kind: "some", ids: [game ids] }');
		return { kind: 'some', ids: [] };
	}
	for (const value of ids) if (!known.some((id) => id === value)) problems.push(`${String(value)} is not a game`);
	return { kind: 'some', ids: known.filter((id) => ids.includes(id)) };
}

/** Boundary parse: a valid email and a grant whose every listed game is known. An unticked game sends nothing and grants nothing. */
export function parseMemberRequest(raw: unknown, known: readonly GameId[]): Parsed<MemberRequest> {
	const problems: string[] = [];
	const email = parseEmail(fieldOf(raw, 'email'));
	if (!email) problems.push('email is not a valid address');
	const games = parseGrant(fieldOf(raw, 'games'), known, problems);
	return email && problems.length === 0 ? { email, games } : { problems };
}

export function parseAccessChange(raw: unknown, known: readonly GameId[]): Parsed<AccessChange> {
	const problems: string[] = [];
	const state = fieldOf(raw, 'state');
	if (state !== 'active' && state !== 'revoked') problems.push('state must be active or revoked');
	const games = parseGrant(fieldOf(raw, 'games'), known, problems);
	return (state === 'active' || state === 'revoked') && problems.length === 0 ? { state, games } : { problems };
}

/** One row of the games screen: a registered game and whether the admin paused it. */
export type GameState = { readonly id: GameId; readonly paused: boolean };

export function parsePauseChange(raw: unknown): Parsed<boolean> {
	const paused = fieldOf(raw, 'paused');
	return typeof paused === 'boolean' ? paused : { problems: ['paused must be true or false'] };
}

/** POST portal/members (admin.console). userIdFor, then the active member row. No Graph. */
export async function saveMember(request: MemberRequest, _session: AdminSession, store: AdminStore): Promise<Member> {
	const member: Member = { userId: await store.userIdFor(request.email), state: 'active', games: request.games };
	await store.putMember(member);
	return member;
}

/** PUT portal/members/{userId} (admin.console). Every games-side app applies it on the next request. */
export async function setAccess(userId: PortalUserId, change: AccessChange, _session: AdminSession, store: AdminStore): Promise<Member> {
	if (!(await store.member(userId))) throw new HttpError(404, 'not_found', 'That member does not exist.');
	const member: Member = { userId, ...change };
	await store.putMember(member);
	return member;
}
