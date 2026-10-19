import { randomUUID } from 'node:crypto';
import type { Email, EntraObjectId } from '@g4k/sdk';
import { parseAssignmentId, type AppRoleGrant, type Assignment, type EntraCall, type OboGraph } from '@g4k/host';
import { newObjectId } from './world.ts';

/** Entra as Graph shows it to the elevated admin: users by email, games4kids's assignments, and grants to the admin app. */
export function fakeGraph() {
	const users = new Map<Email, EntraObjectId>();
	const assignments = new Map<EntraObjectId, Assignment>();
	const grants: AppRoleGrant[] = [];
	const calls: EntraCall[] = [];
	const graph: OboGraph = {
		async findUser(email) {
			calls.push('find-user');
			return users.get(email) ?? null;
		},
		async inviteGuest(email) {
			calls.push('invite');
			const objectId = newObjectId();
			users.set(email, objectId);
			return objectId;
		},
		async assignments() {
			calls.push('list-assignments');
			return [...assignments.values()];
		},
		async assign(objectId) {
			calls.push('assign');
			const assignmentId = parseAssignmentId(randomUUID());
			if (!assignments.has(objectId) && assignmentId) assignments.set(objectId, { objectId, assignmentId });
		},
		async unassign(assignment) {
			calls.push('unassign');
			assignments.delete(assignment.objectId);
		},
		async adminAppGrants() {
			calls.push('list-admin-grants');
			return grants;
		},
	};
	const writes = () => calls.filter((call) => call === 'invite' || call === 'assign' || call === 'unassign');
	const assign = (objectId: EntraObjectId) => graph.assign(objectId);
	return { graph, users, assignments, grants, calls, writes, assign };
}
