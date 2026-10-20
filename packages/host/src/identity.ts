import { parseEmail, type Caller, type Email, type GameId, type Me, type PortalUserId, type Profile } from '@g4k/sdk';
import type { JWTPayload } from 'jose';
import { verifyBearer, type IssuerKey, type TokenRejection, type TrustedIssuer } from './token.ts';

export const GAMES_SCOPE = 'access_as_user';

/** What a verified games4kids token proves. `subject` is the oid. `email` is display only (the not-invited screen). */
export type Identity = { readonly issuer: IssuerKey; readonly subject: string; readonly email: Email | null };

export type Authentication = { readonly ok: true; readonly identity: Identity } | TokenRejection;

/** `jane.doe_outlook.com#EXT#@owner.onmicrosoft.com` is the guest form of `jane.doe@outlook.com`. */
function emailFromGuestUpn(upn: string): string {
	const match = /^(.+)_([^_@#]+)#EXT#@/i.exec(upn);
	return match ? `${match[1]}@${match[2]}` : upn;
}

export function emailFromClaims(claims: JWTPayload): Email | null {
	for (const claim of ['email', 'upn', 'preferred_username']) {
		const value = claims[claim];
		const email = typeof value === 'string' ? parseEmail(emailFromGuestUpn(value)) : null;
		if (email) return email;
	}
	return null;
}

export async function verifyGamesToken(issuers: readonly TrustedIssuer[], authorization: string | null): Promise<Authentication> {
	const verified = await verifyBearer(issuers, authorization, [GAMES_SCOPE]);
	if (!verified.ok) return verified;
	return { ok: true, identity: { issuer: verified.issuer.key, subject: verified.objectId, email: emailFromClaims(verified.claims) } };
}

/**
 * Which games a member may play. `some` hides and refuses every game not listed, including every new game. `all`
 * admits every registered game, including one registered after the row was written.
 */
export type GameGrant = { readonly kind: 'all' } | { readonly kind: 'some'; readonly ids: readonly GameId[] };

export function grants(grant: GameGrant, game: GameId): boolean {
	switch (grant.kind) {
		case 'all':
			return true;
		case 'some':
			return grant.ids.includes(game);
	}
}

/** One members row, written only by the admin app. No email, no object id and no role, so every games-side app may read it. */
export type Member = {
	readonly userId: PortalUserId;
	/** A revoked member keeps the row and PortalUserId, so a re-invite restores the child's history. */
	readonly state: 'active' | 'revoked';
	readonly games: GameGrant;
};

export type Found =
	| { readonly kind: 'known'; readonly userId: PortalUserId; readonly member: Member | undefined; readonly profile: Profile | undefined }
	| { readonly kind: 'unknown' };

export type Admission =
	| { readonly kind: 'player'; readonly caller: Caller; readonly games: GameGrant }
	/** Active member without a profile. The portal app lets this through to /welcome/; a game app answers no_profile. */
	| { readonly kind: 'no-profile'; readonly userId: PortalUserId }
	| { readonly kind: 'not-invited' }
	| { readonly kind: 'not-entitled' };

/** The portal app asks about no game, so nothing it sees is not-entitled. */
export type PortalAdmission = Exclude<Admission, { readonly kind: 'not-entitled' }>;

/**
 * Pure. Checks in Refusal order: known identity with an active member, then a profile, then (for a game app) the
 * game in the member's grants. The portal app passes null.
 */
export function decide(found: Found, game: null): PortalAdmission;
export function decide(found: Found, game: GameId): Admission;
export function decide(found: Found, game: GameId | null): Admission {
	if (found.kind === 'unknown' || found.member?.state !== 'active') return { kind: 'not-invited' };
	const member = found.member;
	if (!found.profile) return { kind: 'no-profile', userId: found.userId };
	if (game !== null && !grants(member.games, game)) return { kind: 'not-entitled' };
	return { kind: 'player', caller: { userId: found.userId, ...found.profile }, games: member.games };
}

/** What every player app may read of the portal tables. */
export type PortalReader = {
	find(identity: Identity): Promise<Found>;
};

/** The portal app's view: the reader plus the one table it writes. No member, identity or email writer. */
export type PortalStore = PortalReader & {
	/** Refuses a display name another child holds. Two children racing for one name is accepted. */
	setProfile(userId: PortalUserId, profile: Profile): Promise<'ok' | 'name_taken'>;
};

/** `registered` is every game on the site. An all-games member gets each one, so the shell shows them. */
export function meFor(identity: Identity, admission: PortalAdmission, registered: readonly GameId[]): Me {
	switch (admission.kind) {
		case 'not-invited':
			return { state: 'not-invited', email: identity.email };
		case 'no-profile':
			return { state: 'no-profile' };
		case 'player': {
			const { userId, displayName, timeZone } = admission.caller;
			return { state: 'active', userId, profile: { displayName, timeZone }, games: registered.filter((game) => grants(admission.games, game)) };
		}
	}
}
