import { ApiFailure, enterAdmin, ready } from '../shell/v1/index.ts';
import { el } from '../../shared/dom.ts';
import { describeDrift, FILTERS, gamesSummary, membersView, needsSync, parseMembers, STANDING_LABEL, standingOf, syncBody, type Attention, type DriftReport, type Filter, type GameGrant, type Listed, type MemberRow, type Standing } from './members-model.ts';

const { api, games, elevated } = await enterAdmin({ game: null });

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof type)) throw new Error(`members page is missing #${id}`);
	return found;
}
const status = byId('status', HTMLElement);
const search = byId('search', HTMLInputElement);
const filters = byId('filters', HTMLElement);
const attention = byId('attention', HTMLElement);
const people = byId('people', HTMLUListElement);
const addPerson = byId('add-person', HTMLButtonElement);
const personDialog = byId('person', HTMLDialogElement);
const personTitle = byId('person-title', HTMLElement);
const personBody = byId('person-body', HTMLElement);
const addDialog = byId('add', HTMLDialogElement);
const addBody = byId('add-body', HTMLElement);
const reportDialog = byId('report', HTMLDialogElement);
const driftList = byId('drift', HTMLUListElement);

let rows: readonly MemberRow[] = [];
let report: DriftReport = { kind: 'unchecked' };
let query = '';
let filter: Filter = 'all';

type Say = (message: string, problem?: boolean) => void;

const sayIn =
	(element: HTMLElement): Say =>
	(message, problem = false) => {
		element.textContent = message;
		element.classList.toggle('problem', problem);
	};
const say = sayIn(status);

function explain(error: unknown): string {
	if (error instanceof ApiFailure) return error.problems.length > 0 ? `${error.message} ${error.problems.join(' ')}` : error.message;
	if (error instanceof Error && /popup/i.test(error.message)) return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
	if (error instanceof Error && /cancel|closed/i.test(error.message)) return 'The sign-in was cancelled, so nothing changed in Entra.';
	return 'Something went wrong. Nothing was changed.';
}

/** Runs one action while its scope is busy, so a second tap cannot send it twice, and reports a failure where it was asked. */
async function attempt(scope: HTMLElement, tell: Say, work: () => Promise<void>): Promise<void> {
	if (scope.ariaBusy === 'true') return;
	scope.ariaBusy = 'true';
	try {
		await work();
	} catch (error) {
		tell(explain(error), true);
	} finally {
		scope.ariaBusy = null;
	}
}

const BUTTON_CLASS = { primary: 'g4k-button', quiet: 'g4k-button quiet', danger: 'g4k-button danger' } as const;

function button(label: string, run: () => void, kind: keyof typeof BUTTON_CLASS = 'primary', action = ''): HTMLButtonElement {
	const element = el('button', { type: 'button', class: BUTTON_CLASS[kind], ...(action ? { 'data-action': action } : {}) }, label);
	element.addEventListener('click', run);
	return element;
}

const NONE: GameGrant = { kind: 'some', ids: [] };

/** Ticking every game disables the per-game boxes and keeps their ticks, so unticking it restores the list. */
function gameBoxes(container: HTMLElement, grant: GameGrant, idPrefix: string): void {
	const every = el('input', { type: 'checkbox', class: 'every', id: `${idPrefix}-all` });
	every.checked = grant.kind === 'all';
	const boxes = games.map((game) => {
		const box = el('input', { type: 'checkbox', value: game.id, id: `${idPrefix}-${game.id}` });
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

const badge = (standing: Standing) => el('span', { class: `badge ${standing}` }, STANDING_LABEL[standing]);

const chipCounts = new Map<Filter, HTMLElement>();
for (const { id, label } of FILTERS) {
	const radio = el('input', { type: 'radio', name: 'filter', value: id, id: `filter-${id}` });
	radio.checked = id === filter;
	radio.addEventListener('change', () => {
		filter = id;
		render();
	});
	const count = el('span', { class: 'count' });
	chipCounts.set(id, count);
	filters.append(el('label', { class: 'chip', for: radio.id }, radio, `${label} `, count));
}

search.addEventListener('input', () => {
	query = search.value;
	render();
});

function render(): void {
	const view = membersView(rows, report, games, query, filter);
	for (const [id, count] of chipCounts) count.textContent = String(view.counts[id]);
	attention.replaceChildren(...(rows.length === 0 ? [] : banner(view.attention)));
	people.replaceChildren(...listItems(view.listed));
}

function listItems(listed: readonly Listed[]): HTMLLIElement[] {
	if (rows.length === 0) {
		return [el('li', { class: 'empty' }, el('p', {}, 'No one has been added yet. Add a person and pick the games they can play.'), button('Add your first person', () => openAdd(addPerson)))];
	}
	if (listed.length === 0) {
		const reset = button(
			'Show everyone',
			() => {
				query = '';
				search.value = '';
				filter = 'all';
				byId('filter-all', HTMLInputElement).checked = true;
				render();
				search.focus();
			},
			'quiet',
		);
		return [el('li', { class: 'empty' }, el('p', {}, query.trim() ? `No one matches “${query.trim()}”.` : 'No one is in this group.'), reset)];
	}
	return listed.map(({ row, standing, games: summary }) => {
		const open = el(
			'button',
			{ type: 'button', class: 'person', 'data-user-id': row.userId },
			el('span', { class: 'email' }, row.email),
			el('span', { class: 'detail' }, ...(row.displayName ? [el('span', { class: 'name' }, row.displayName)] : []), el('span', { class: 'games' }, summary)),
			badge(standing),
		);
		open.addEventListener('click', () => openPerson(row.userId, open));
		return el('li', {}, open);
	});
}

const plural = (count: number) => (count === 1 ? '1 person isn’t' : `${count} people aren’t`);

function banner(state: Attention): HTMLElement[] {
	const check = button('Check Entra', () => void checkEntra(), 'quiet');
	const see = button('See report', () => openReport(), 'quiet');
	const syncNow = button('Sync now', () => void attempt(attention, say, () => runSync(null, say)));
	switch (state.kind) {
		case 'alarm':
			return [
				el(
					'div',
					{ class: 'banner alarm', role: 'alert' },
					el('ul', {}, ...state.alarms.map((line) => el('li', {}, line.text))),
					...(state.people > 0 ? [el('p', {}, `${plural(state.people)} synced with Entra.`)] : []),
					el('p', { class: 'banner-actions' }, ...(state.people > 0 ? [syncNow] : []), see),
				),
			];
		case 'needs-sync':
			return [el('div', { class: 'banner' }, el('p', {}, `${plural(state.people)} synced with Entra.`), el('p', { class: 'banner-actions' }, syncNow, check))];
		case 'quiet':
			return [el('div', { class: 'banner quiet' }, el('p', {}, state.report === 'checked' ? 'Entra and this list agree.' : 'Everyone active is linked with Entra.'), el('p', { class: 'banner-actions' }, ...(state.report === 'checked' ? [see] : []), check))];
	}
}

async function load(): Promise<void> {
	rows = parseMembers(await api.get('members'));
	render();
}

const ELEVATING = 'Sign in again in the window that opens. This keeps Entra changes behind your password.';

async function runSync(only: string | null, tell: Say): Promise<void> {
	tell(ELEVATING);
	const left = await elevated((elevatedApi) => elevatedApi.post<unknown>('entra/sync', syncBody(only)));
	await load();
	setReport(left);
	tell(only === null ? 'Everyone is synced with Entra.' : 'Synced with Entra.');
}

async function runCheck(tell: Say): Promise<void> {
	tell(ELEVATING);
	setReport(await elevated((elevatedApi) => elevatedApi.get<unknown>('entra')));
}

function setReport(raw: unknown): void {
	report = { kind: 'checked', lines: describeDrift(raw, rows) };
	render();
	driftList.replaceChildren(...(report.lines.length === 0 ? [el('li', {}, 'Entra and this list agree.')] : report.lines.map((line) => el('li', { class: line.alarm ? 'alarm' : '' }, line.text))));
}

async function checkEntra(): Promise<void> {
	await attempt(attention, say, async () => {
		await runCheck(say);
		say('');
		openReport();
		reportSay('Checked Entra.');
	});
}

const openers = new WeakMap<HTMLDialogElement, () => HTMLElement | null>();

function show(dialog: HTMLDialogElement, returnTo: () => HTMLElement | null): void {
	openers.set(dialog, returnTo);
	for (const feedback of dialog.querySelectorAll<HTMLElement>('.feedback')) sayIn(feedback)('');
	if (!dialog.open) dialog.showModal();
}

for (const dialog of [personDialog, addDialog, reportDialog]) {
	dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
	dialog.addEventListener('close', () => (openers.get(dialog)?.() ?? search).focus());
}

const reportSay = sayIn(byId('report-status', HTMLElement));
const reportActions = byId('report-actions', HTMLElement);

function openReport(): void {
	if (report.kind === 'unchecked') driftList.replaceChildren(el('li', {}, 'Entra has not been checked yet.'));
	show(reportDialog, () => attention.querySelector('button'));
}

byId('sync-all', HTMLButtonElement).addEventListener('click', () => void attempt(reportActions, reportSay, () => runSync(null, reportSay)));
byId('check-again', HTMLButtonElement).addEventListener('click', () =>
	void attempt(reportActions, reportSay, async () => {
		await runCheck(reportSay);
		reportSay('Checked Entra.');
	}),
);

const personSay = sayIn(byId('person-status', HTMLElement));
const addSay = sayIn(byId('add-status', HTMLElement));

function openPerson(userId: string, opener: HTMLElement): void {
	if (!drawPerson(userId)) return;
	show(personDialog, () => people.querySelector<HTMLElement>(`[data-user-id="${CSS.escape(userId)}"]`) ?? opener);
}

/** Keeps focus on the action just used, since a redraw replaces every element in the sheet. */
function drawPerson(userId: string, promoteSync = false): boolean {
	const row = rows.find((candidate) => candidate.userId === userId);
	if (!row) return false;
	const focused = document.activeElement instanceof HTMLElement && personBody.contains(document.activeElement) ? document.activeElement.dataset['action'] : undefined;
	const standing = standingOf(row, report);
	personTitle.textContent = row.email;

	const boxes = el('div', { class: 'boxes' });
	gameBoxes(boxes, row.games, 'person');
	const after = async (message: string, offerSync: boolean) => {
		await load();
		drawPerson(userId, offerSync);
		personSay(offerSync ? `${message} Sync with Entra below so Entra matches.` : message);
	};
	const put = (state: MemberRow['state'], message: string) =>
		void attempt(personBody, personSay, async () => {
			await api.put(`members/${row.userId}`, { state, games: grantOf(boxes) });
			await after(message, state !== row.state);
		});

	const linkText = row.linked ? 'Linked to their Entra account.' : 'Not synced yet. Their sign-in works only after a sync with Entra.';
	const syncPerson = () =>
		void attempt(personBody, personSay, async () => {
			await runSync(row.userId, personSay);
			drawPerson(userId);
		});
	const sync = button('Sync with Entra', syncPerson, needsSync(standing) || promoteSync ? 'primary' : 'quiet', 'sync');

	const access = el('section', { class: 'sheet-section', 'aria-label': 'Access' });
	const accessIdle = () => {
		if (row.state === 'revoked') {
			access.replaceChildren(el('p', {}, 'Revoked. Every call they make is refused.'), button('Restore access', () => put('active', `${row.email} is active again.`), 'quiet', 'access'));
			return;
		}
		access.replaceChildren(
			el('p', {}, 'Revoking stops every call they make, straight away.'),
			button(
				'Revoke access',
				() => {
					const cancel = button('Cancel', () => {
						accessIdle();
						access.querySelector<HTMLElement>('[data-action="access"]')?.focus();
					}, 'quiet');
					access.replaceChildren(el('p', { class: 'confirm' }, `Revoke ${row.email}? Their next call is refused.`), el('p', { class: 'sheet-actions' }, button('Yes, revoke', () => put('revoked', `${row.email} is revoked. Their next call is refused.`), 'danger', 'access'), cancel));
					cancel.focus();
				},
				'quiet',
				'access',
			),
		);
	};
	accessIdle();

	personBody.replaceChildren(
		el('p', { class: 'who' }, ...(row.displayName ? [el('span', { class: 'name' }, row.displayName)] : []), badge(standing)),
		el(
			'section',
			{ class: 'sheet-section', 'aria-label': 'Games' },
			el('fieldset', { class: 'field' }, el('legend', {}, 'Games'), boxes),
			button('Save games', () => put(row.state, `Saved games for ${row.email}.`), 'primary', 'save'),
		),
		el('section', { class: 'sheet-section', 'aria-label': 'Entra' }, el('p', {}, linkText), sync),
		access,
	);
	if (focused) personBody.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus();
	return true;
}

function openAdd(opener: HTMLElement): void {
	drawAddForm();
	show(addDialog, () => opener);
	addBody.querySelector('input')?.focus();
}

function drawAddForm(): void {
	const email = el('input', { id: 'add-email', type: 'email', autocomplete: 'off', required: '', spellcheck: 'false' });
	const boxes = el('div', { class: 'boxes' });
	gameBoxes(boxes, NONE, 'add');
	const form = el(
		'form',
		{},
		el('div', { class: 'field' }, el('label', { for: email.id }, 'Email'), email),
		el('fieldset', { class: 'field' }, el('legend', {}, 'Games to switch on'), boxes),
		el('p', { class: 'sheet-actions' }, el('button', { class: 'g4k-button', type: 'submit' }, 'Save person')),
	);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		void attempt(addBody, addSay, async () => {
			const address = email.value.trim();
			const saved = await api.post<{ readonly userId: string }>('members', { email: address, games: grantOf(boxes) });
			await load();
			drawAddSaved(saved.userId, address);
		});
	});
	addBody.replaceChildren(form);
}

function drawAddSaved(userId: string, address: string): void {
	addSay(`Saved ${address}. Sync now so their sign-in works.`);
	const row = rows.find((candidate) => candidate.userId === userId);
	const summary = row ? [el('p', {}, `Games: ${gamesSummary(row.games, games)}.`)] : [];
	const another = button('Add another', () => {
		addSay('');
		drawAddForm();
		addBody.querySelector('input')?.focus();
	}, 'quiet');
	const syncNow = button('Sync now', () =>
		void attempt(addBody, addSay, async () => {
			await runSync(userId, addSay);
			addSay(`${address} is synced with Entra and can sign in now.`);
			const done = button('Done', () => addDialog.close());
			addBody.replaceChildren(el('p', { class: 'sheet-actions' }, done, another));
			done.focus();
		}),
	);
	addBody.replaceChildren(...summary, el('p', { class: 'sheet-actions' }, syncNow, another));
	syncNow.focus();
}

addPerson.addEventListener('click', () => openAdd(addPerson));

await attempt(attention, say, async () => {
	await load();
	say('');
});
ready();
