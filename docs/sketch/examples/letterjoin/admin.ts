/**
 * games/letterjoin/admin/api: today's manage/* routes, keyed by PortalUserId. manage/users goes (members live in the
 * portal), and a review writes the reviews table, so the player app stays the only writer of submissions.
 */
import { defineAdminApi } from '../../host';
import manifest from './manifest';

declare function parseReviewInput(body: unknown): { reviewed: boolean; note?: string };

export const createAdminApi = defineAdminApi(manifest, ({ tables }) => ({
	routes: [
		{
			name: 'reviewSubmission',
			method: 'PATCH',
			path: 'submissions/{id}',
			body: 'json',
			async run({ admin, params, body, now }) {
				const review = parseReviewInput(body);
				await tables.reviews.put({ partitionKey: 'review', rowKey: params.id ?? '', ...review, reviewedBy: admin.email, reviewedAt: now.toISOString() });
				return { status: 204 };
			},
		},
	],
}));
