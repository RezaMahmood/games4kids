import { randomUUID } from 'node:crypto';
import { parseEntraObjectId, type EntraObjectId } from '@g4k/sdk';

export type DirectoryUser = {
	readonly id: EntraObjectId;
	readonly mail: string;
	readonly otherMails: readonly string[];
	readonly upn: string;
	readonly guest: boolean;
};

export function newObjectId(): EntraObjectId {
	const id = parseEntraObjectId(randomUUID());
	if (!id) throw new Error('a UUID is an object id');
	return id;
}

/** `jane@outlook.com` invited as a guest has the UPN `jane_outlook.com#EXT#@<tenant>.onmicrosoft.com`. */
export const guestUpn = (email: string) => `${email.replace('@', '_')}#EXT#@devtenant.onmicrosoft.com`;

/** The tenant's people, shared by the fake IdP (who signs in) and the fake Graph (who is invited and assigned). */
export type Directory = {
	readonly users: ReadonlyMap<EntraObjectId, DirectoryUser>;
	add(user: Omit<DirectoryUser, 'id' | 'upn' | 'otherMails'> & { readonly id?: EntraObjectId; readonly upn?: string; readonly otherMails?: readonly string[] }): DirectoryUser;
	byEmail(email: string): DirectoryUser | undefined;
	byId(id: string): DirectoryUser | undefined;
};

export function createDirectory(): Directory {
	const users = new Map<EntraObjectId, DirectoryUser>();
	const matches = (user: DirectoryUser, email: string) =>
		[user.mail, user.upn, ...user.otherMails].some((candidate) => candidate.toLowerCase() === email.toLowerCase());
	return {
		users,
		add(input) {
			const user: DirectoryUser = {
				id: input.id ?? newObjectId(),
				mail: input.mail,
				otherMails: input.otherMails ?? [],
				upn: input.upn ?? (input.guest ? guestUpn(input.mail) : input.mail),
				guest: input.guest,
			};
			users.set(user.id, user);
			return user;
		},
		byEmail: (email) => [...users.values()].find((user) => matches(user, email)),
		byId: (id) => [...users.values()].find((user) => user.id === id),
	};
}
