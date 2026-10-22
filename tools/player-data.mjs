// Run on your Mac, signed in with `az login`. Reads one child's data and never writes. You need Storage Table Data Reader
// on each tagged account, which `node tools/bootstrap.mjs --apply --after-first-deploy` gives you.
//
//   node tools/player-data.mjs who <name or id>                         the children a name matches, with their grants
//   node tools/player-data.mjs rows <name or id> [--out file.json]      every row in every game and portal table that names the child
//   node tools/player-data.mjs timeline <name or id> --from <iso> [--to <iso>] [--all]   the requests that touched the child, with their
//                                                                         table writes; --all also lists admission's portal reads

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { relaunchWithSource } from './migrate/launch.mjs';

relaunchWithSource(fileURLToPath(import.meta.url));

const { RESOURCE_GROUP } = await import('./deploy.ts');
const { findPlayers, formatTimeline, mentioning, parseTimeline, timelineQuery } = await import('./player-data.ts');

const APP_INSIGHTS = 'appi-g4k';
const NO_ROLE = /AuthorizationPermissionMismatch|AuthorizationFailure|required permissions/;

const { positionals, values } = parseArgs({ allowPositionals: true, options: { from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string' }, all: { type: 'boolean', default: false } } });
const [command, ...words] = positionals;
const query = words.join(' ');

function az(args) {
	try {
		return JSON.parse(execFileSync('az', [...args, '--only-show-errors', '-o', 'json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) || 'null');
	} catch (error) {
		const stderr = String(error.stderr ?? error.message);
		if (NO_ROLE.test(stderr)) throw new Error(`you cannot read ${args.join(' ')}. Run node tools/bootstrap.mjs --apply --after-first-deploy, then wait a few minutes for the role to arrive`, { cause: error });
		throw new Error(stderr.trim(), { cause: error });
	}
}

/** Every row of a table, page by page. */
function entities(account, table) {
	const rows = [];
	let marker = null;
	do {
		const page = az(['storage', 'entity', 'query', '--account-name', account, '--table-name', table, '--auth-mode', 'login', '--num-results', '1000', ...(marker ? ['--marker', `nextpartitionkey=${marker.nextpartitionkey}`, `nextrowkey=${marker.nextrowkey}`] : [])]);
		rows.push(...page.items);
		marker = page.nextMarker && page.nextMarker.nextpartitionkey ? page.nextMarker : null;
	} while (marker);
	return rows;
}

const accounts = () => az(['storage', 'account', 'list', '--resource-group', RESOURCE_GROUP, '--query', "[?tags.game!=null && tags.game!='shared'].{name:name,game:tags.game}"]);

function player() {
	if (!query) throw new Error('name a child: their display name, or part of it, or their user id');
	const portal = accounts().find((account) => account.game === 'portal');
	if (!portal) throw new Error(`no storage account in ${RESOURCE_GROUP} has the tag game=portal`);
	const found = findPlayers(entities(portal.name, 'profiles'), entities(portal.name, 'members'), query);
	if (command !== 'who' && found.length !== 1) {
		for (const one of found) console.error(`${one.userId}  ${one.name}`);
		throw new Error(found.length === 0 ? `no child's display name contains "${query}"` : `"${query}" names ${found.length} children. Pass one user id`);
	}
	return found;
}

try {
	if (command === 'who') {
		for (const one of player()) console.log(`${one.userId}  ${one.name}  (${one.timeZone})  ${one.state}  games: ${one.games || 'none'}`);
	} else if (command === 'rows') {
		const [one] = player();
		const found = [];
		for (const account of accounts()) {
			for (const table of az(['storage', 'table', 'list', '--account-name', account.name, '--auth-mode', 'login', '--query', '[].name'])) found.push(...mentioning(one.userId, account.game, table, entities(account.name, table)));
		}
		console.log(`${one.name}  ${one.userId}  (${one.timeZone})  ${found.length} rows`);
		for (const row of found) console.log(`${row.account}/${row.table}  ${row.partitionKey} | ${row.rowKey}  ${JSON.stringify(row.fields)}`);
		if (values.out) writeFileSync(values.out, `${JSON.stringify({ player: one, rows: found }, null, '\t')}\n`);
	} else if (command === 'timeline') {
		const [one] = player();
		const from = new Date(values.from ?? '');
		const to = values.to ? new Date(values.to) : new Date();
		if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('pass --from (and optionally --to) as ISO times, such as 2026-10-22T18:00Z');
		const reply = az(['monitor', 'app-insights', 'query', '--resource-group', RESOURCE_GROUP, '--app', APP_INSIGHTS, '--analytics-query', timelineQuery(one.userId, from, to)]);
		const entries = parseTimeline(reply);
		console.log(`${one.name}  ${one.userId}  ${entries.length} requests from ${from.toISOString()} to ${to.toISOString()}`);
		for (const line of formatTimeline(entries, { all: values.all })) console.log(line);
	} else {
		throw new Error('usage: node tools/player-data.mjs who|rows|timeline <name or id> [--from <iso>] [--to <iso>] [--all] [--out file.json]');
	}
} catch (error) {
	console.error(error.message);
	process.exit(2);
}
