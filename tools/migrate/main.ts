import { DefaultAzureCredential } from '@azure/identity';
import { azureAccounts } from '@g4k/host/azure';
import type { Row } from '@g4k/sdk';
import { parseActivity } from '../../games/letterjoin/data/activity.ts';
import { newAccounts, openOldAccount, readPortal } from './accounts.ts';
import type { ContentRules } from './content.ts';
import { NO_PORTAL_ROWS } from './player-data.ts';
import type { Io } from './shell.ts';

export function activityProblem(row: Row): string | null {
	const { rowKey: id, type, title, description, status, order, updatedAt, body } = row;
	if (typeof body !== 'string') return 'an activity has no body';
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return 'an activity body is not JSON';
	}
	if (typeof parsed !== 'object' || parsed === null) return 'an activity body is not an object';
	const result = parseActivity({ ...parsed, id, type, title, description, status, order, updatedAt });
	return result.ok ? null : 'an activity does not parse as the new activity';
}

export const contentRules: ContentRules = { activityProblem };

export function realIo(): Io {
	return {
		print: (line) => console.log(line),
		async connect(options) {
			const credential = new DefaultAzureCredential();
			const from = { drawpad: openOldAccount(options.accounts.drawpad, credential), letterjoin: openOldAccount(options.accounts.letterjoin, credential) };
			if (!options.suffix) return { from, to: null, portal: NO_PORTAL_ROWS };
			const accounts = azureAccounts({ kind: 'azure', suffix: options.suffix, credential });
			return { from, to: newAccounts(accounts), portal: await readPortal(accounts) };
		},
	};
}
