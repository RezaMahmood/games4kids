import { ApiFailure, enterAdmin } from '../shell/v1/index.ts';
import { el } from '../../shared/dom.ts';
import { describeDrift, parseMembers, syncBody, type GameGrant, type MemberRow } from './members-model.ts';

const { api, games, elevated } = await enterAdmin({ game: null });

const byId = (id: string) => {
	const found = document.getElementById(id);
	if (!found) throw new Error(`members page is missing #${id}`);
	return found;
};
const status = byId('status');
const addForm = byId('add');
const addEmail = byId('add-email');
const addGames = byId('add-games');
const people = byId('people');
const drift = byId('drift');
const syncOffer = byId('sync-offer');
if (!(addForm instanceof HTMLFormElement) || !(addEmail instanceof HTMLInputElement) || !(people instanceof HTMLTableSectionElement)) throw new Error('members page is malformed');

let rows: readonly MemberRow[] = [];

const say = (message: string, problem = false) => {
	status.textContent = message;
	status.classList.toggle('problem', problem);
};

function explain(error: unknown): string {
	if (error instanceof ApiFailure) return error.problems.length > 0 ? `${error.message} ${error.problems.join(' ')}` : error.message;
	if (error instanceof Error && /popup/i.test(error.message)) return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
	if (error instanceof Error && /cancel|closed/i.test(error.message)) return 'The sign-in was cancelled, so nothing changed in Entra.';
	return 'Something went wrong. Nothing was changed.';
}

async function attempt(work: () => Promise<void>): Promise<void> {
	try {
		await work();
	} catch (error) {
		say(explain(error), true);
	}
}

const NONE: GameGrant = { kind: 'some', ids: [] };

/** Ticking every game disables the per-game boxes and keeps their ticks, so unticking it restores the list. */
function gameBoxes(container: HTMLElement, name: string, grant: GameGrant, idPrefix: string): void {
	const every = el('input', { type: 'checkbox', name: `${name}-all`, class: 'every', id: `${idPrefix}-all` });
	every.checked = grant.kind === 'all';
	const boxes = games.map((game) => {
		const box = el('input', { type: 'checkbox', name, value: game.id, id: `${idPrefix}-${game.id}` });
		box.checked = grant.kind === 'some' && grant.ids.includes(game.id);
		return { box, label: el('label', { class: 'tick', for: box.id }, box, ` ${game.title}`) };
	});
	const sync = () => {
		for (const { box } of boxes) box.disabled = every.checked;
	};
	every.addEventListener('change', sync);
	sync();
	container.replaceChildren(el('label', { class: 'tick', for: every.id }, every, ' Every game, including new ones'), ...boxes.map(({ label }) => label));
}

function grantOf(container: HTMLElement): GameGrant {
	const every = container.querySelector('input.every');
	if (every instanceof HTMLInputElement && every.checked) return { kind: 'all' };
	const ids = [...container.querySelectorAll('input[type=checkbox]:not(.every)')].flatMap((box) => (box instanceof HTMLInputElement && box.checked ? [box.value] : []));
	return { kind: 'some', ids };
}

async function load(): Promise<void> {
	rows = parseMembers(await api.get('members'));
	people.replaceChildren(...rows.map(rowFor));
	if (rows.length === 0) say('No one has been added yet.');
}

function offerSync(userId: string, email: string): void {
	const button = el('button', { type: 'button', class: 'g4k-button' }, `Sync ${email} with Entra`);
	button.addEventListener('click', () => void attempt(() => runSync(userId)));
	syncOffer.replaceChildren(el('p', {}, `${email} is saved. Their sign-in only works after a sync with Entra.`), button);
}

async function runSync(only: string | null): Promise<void> {
	say('Sign in again in the window that opens. This keeps Entra changes behind your password.');
	const left = await elevated((elevatedApi) => elevatedApi.post<unknown>('entra/sync', syncBody(only)));
	syncOffer.replaceChildren();
	await load();
	showDrift(left);
	say(only === null ? 'Everyone is synced with Entra.' : 'Synced with Entra.');
}

function showDrift(raw: unknown): void {
	const lines = describeDrift(raw, rows);
	drift.replaceChildren(...(lines.length === 0 ? [el('li', {}, 'Entra and this list agree.')] : lines.map((line) => el('li', { class: line.alarm ? 'alarm' : '' }, line.text))));
}

function rowFor(row: MemberRow): HTMLTableRowElement {
	const boxes = el('td', { class: 'games' });
	gameBoxes(boxes, `games-${row.userId}`, row.games, `row-${row.userId.slice(0, 8)}`);
	const button = (label: string, run: () => Promise<void>, quiet = false) => {
		const element = el('button', { type: 'button', class: quiet ? 'g4k-button quiet' : 'g4k-button' }, label);
		element.addEventListener('click', () => void attempt(run));
		return element;
	};
	const change = async (state: 'active' | 'revoked', message: string) => {
		await api.put(`members/${row.userId}`, { state, games: grantOf(boxes) });
		await load();
		say(message);
		if (state === 'revoked') offerSync(row.userId, row.email);
	};
	return el(
		'tr',
		{},
		el('th', { scope: 'row' }, row.email, row.displayName ? el('span', { class: 'name' }, ` (${row.displayName})`) : ''),
		el('td', {}, row.state === 'active' ? 'Active' : 'Revoked'),
		boxes,
		el('td', {}, row.linked ? 'Linked' : 'Not synced'),
		el(
			'td',
			{ class: 'actions' },
			button('Save games', () => change(row.state, `Saved games for ${row.email}.`), true),
			row.state === 'active' ? button('Revoke', () => change('revoked', `${row.email} is revoked. Their next call is refused.`), true) : button('Restore', () => change('active', `${row.email} is active again.`), true),
			button('Sync', () => runSync(row.userId), true),
		),
	);
}

gameBoxes(addGames, 'games', NONE, 'add');

addForm.addEventListener('submit', (event) => {
	event.preventDefault();
	void attempt(async () => {
		const email = addEmail.value.trim();
		const saved = await api.post<{ readonly userId: string }>('members', { email, games: grantOf(addGames) });
		addEmail.value = '';
		gameBoxes(addGames, 'games', NONE, 'add');
		await load();
		say(`Saved ${email}.`);
		offerSync(saved.userId, email);
	});
});

byId('check').addEventListener('click', () =>
	void attempt(async () => {
		say('Sign in again in the window that opens. This keeps Entra changes behind your password.');
		showDrift(await elevated((elevatedApi) => elevatedApi.get<unknown>('entra')));
		say('Checked Entra.');
	}),
);

byId('sync-all').addEventListener('click', () => void attempt(() => runSync(null)));

await attempt(load);
