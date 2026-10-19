/**
 * tools/invite.mjs and tools/members.mjs. The admin runs them on a laptop, signed in with `az login`. They are
 * the only code that calls Microsoft Graph, and they call it with the admin's own token, so the shared backend
 * holds no tenant-wide permission.
 *
 * The portal rows are the intent and the Entra assignment follows them. Each tool reads the current state of
 * both lists and applies only the difference, per make-operations-idempotent, so a rerun after a crash at any
 * step converges.
 */

import type { DriftReport, Email, EntraObjectId, Grants, Invite, IdentityStore, PortalRole, PortalUserId } from './identity';

/** Graph with the admin's delegated token. Never the Function app's identity. */
export type GraphAsAdmin = {
	findUser(email: Email): Promise<EntraObjectId | null>;
	/** A B2B guest invitation. Graph treats a repeat for the same email as a no-op and returns the same object id. */
	inviteGuest(email: Email, redirectUrl: string): Promise<EntraObjectId>;
	/** Assignments to the games4kids enterprise app. Every assignment uses the default access role; roles live in portalMembers. */
	assignments(): Promise<readonly { readonly principalId: EntraObjectId; readonly email: Email | null }[]>;
	/** An existing assignment counts as done. */
	assign(principalId: EntraObjectId): Promise<void>;
	/** A missing assignment counts as done. */
	unassign(principalId: EntraObjectId): Promise<void>;
};

/**
 * /api/portal/admin/* with a token from `az account get-access-token --scope api://<clientId>/access_as_user`.
 * tools/bootstrap.mjs adds Azure CLI as an authorized client of that scope. The host checks portal admin as for
 * the /admin/ hub, so the CLI and the hub share one writer of the portal tables and one parseGrants.
 */
export type PortalAdminApi = {
	invite(invite: Invite): Promise<void>;
	list(): ReturnType<IdentityStore['list']>;
	revoke(userId: PortalUserId): Promise<void>;
	saveDrift(report: DriftReport): Promise<void>;
};

export type InviteRequest = { readonly email: Email; readonly portalRole: PortalRole; readonly grants: Grants };

/**
 * `node tools/invite.mjs <email> [--role admin] [--grant drawpad=player ...]`. Three steps, each safe to repeat:
 *   1. upsert the join invite through PortalAdminApi, harmless alone because Entra still refuses the account
 *   2. findUser, or inviteGuest when the account is not in the tenant
 *   3. assign
 * A crash after step 1 leaves an invite without an assignment, which reconcile reports and `--fix` finishes.
 */
export function invite(request: InviteRequest, graph: GraphAsAdmin, portal: PortalAdminApi, redirectUrl: string): Promise<{ readonly principalId: EntraObjectId; readonly guestInvited: boolean }> {
	throw new Error('not implemented');
}

export type Fix =
	/** Find or guest-invite the account by email, then assign it. */
	| { readonly kind: 'assign'; readonly email: Email }
	| { readonly kind: 'unassign'; readonly principalId: EntraObjectId };

/**
 * Pure, table-tested. Matches an assignment to a member by Entra object id (the member's 'entra' identity
 * subject) and to an invite by email. BOOTSTRAP_ADMIN_EMAILS count as rows, so the admin's own assignment is
 * not drift before the admin's first sign-in.
 */
export function reconcile(
	assignments: Awaited<ReturnType<GraphAsAdmin['assignments']>>,
	rows: Awaited<ReturnType<PortalAdminApi['list']>>,
	bootstrapAdmins: ReadonlySet<Email>,
	checkedAt: Date,
): DriftReport {
	throw new Error('not implemented');
}

/** One fix per drift entry. Applying them and reconciling again yields an empty report. */
export function fixesFor(report: DriftReport): readonly Fix[] {
	throw new Error('not implemented');
}

/**
 * `node tools/members.mjs reconcile [--fix]` prints the report and uploads it for the /admin/ hub; `--fix`
 * applies fixesFor first. `node tools/members.mjs revoke <email>` calls portal revoke, then unassign, so the portal
 * gate closes first, and a crash between the two leaves 'revoked-but-assigned', which `--fix` finishes.
 */
export type MembersCommand =
	| { readonly kind: 'reconcile'; readonly fix: boolean }
	| { readonly kind: 'revoke'; readonly email: Email };
