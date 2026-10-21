import { ApiFailure, enterAdmin, ready } from '../shell/v1/index.ts';
import { el } from '../../shared/dom.ts';
import { checkedReport, FILTERS, gamesSummary, membersView, needsSync, parseMembers, STANDING_LABEL, standingOf, syncBody, type Attention, type DriftReport, type Filter, type GameGrant, type Listed, type MemberRow, type Standing } from './members-model.ts';

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
const alarms = byId('alarms', HTMLElement);
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

/** One sync at a time across the page. aria-disabled rather than disabled, so a focused sync button keeps focus. */
let syncing = false;

function markSyncing(on: boolean): void {
	syncing = on;
	for (const element of document.querySelectorAll<HTMLElement>('[data-sync]')) element.ariaDisabled = on ? 'true' : null;
}

function syncButton(label: string, run: () => void, kind: keyof typeof BUTTON_CLASS, action: string): HTMLButtonElement {
	const element = button(
		label,
		() => {
			if (!syncing) run();
		},
		kind,
		action,
	);
	element.dataset['sync'] = '';
	element.ariaDisabled = syncing ? 'true' : null;
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

/** A redraw replaces the banner's buttons, so focus inside it moves to the same action, or to its heading when that action is gone. */
function render(): void {
	const view = membersView(rows, report, games, query, filter);
	for (const [id, count] of chipCounts) count.textContent = String(view.counts[id]);
	const focused = document.activeElement instanceof HTMLElement && attention.contains(document.activeElement) ? (document.activeElement.dataset['action'] ?? '') : null;
	attention.replaceChildren(banner(view.attention));
	if (focused !== null) (attention.querySelector<HTMLElement>(`[data-action="${focused}"]`) ?? attention.querySelector<HTMLElement>('.banner-title'))?.focus();
	alarms.replaceChildren(...(view.attention.kind === 'alarm' ? [el('ul', { class: 'alarm-list', 'aria-label': 'Entra alarms' }, ...view.attention.alarms.map((line) => el('li', {}, line.text)))] : []));
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
		open.addEventListener('click', () => openPerson(row.userId));
		return el('li', {}, open);
	});
}

const notSynced = (count: number) => (count === 1 ? '1 person isn’t synced with Entra.' : `${count} people aren’t synced with Entra.`);

function bannerTitle(state: Attention): string {
	switch (state.kind) {
		case 'alarm':
			return state.alarms.length === 1 ? 'Entra raised an alarm.' : `Entra raised ${state.alarms.length} alarms.`;
		case 'needs-sync':
			return notSynced(state.people);
		case 'unchecked':
			return 'Not checked against Entra yet.';
		case 'notes':
			return state.notes === 1 ? '1 note from Entra.' : `${state.notes} notes from Entra.`;
		case 'agree':
			return 'Entra and this list agree.';
	}
}

const TONE: Readonly<Record<Attention['kind'], string>> = { alarm: 'alarm', 'needs-sync': '', unchecked: 'quiet', notes: 'quiet', agree: 'quiet' };

/**
 * Every state, with no one listed too, leads to the report and its Check again and Sync everyone: Check Entra until
 * Entra has answered, See report after.
 */
function banner(state: Attention): HTMLElement {
	const people = state.kind === 'alarm' || state.kind === 'needs-sync' ? state.people : 0;
	const actions = [
		...(people > 0 ? [syncButton('Sync now', () => void attempt(attention, say, () => runSync(null, say)), 'primary', 'sync-all')] : []),
		report.kind === 'checked' ? button('See report', () => openReport(), 'quiet', 'report') : button('Check Entra', () => void checkEntra(), 'quiet', 'report'),
	];
	return el(
		'div',
		{ class: `banner ${TONE[state.kind]}` },
		el('h2', { class: 'banner-title', tabindex: '-1' }, bannerTitle(state)),
		...(state.kind === 'alarm' && people > 0 ? [el('p', {}, notSynced(people))] : []),
		el('p', { class: 'banner-actions' }, ...actions),
	);
}

async function load(): Promise<void> {
	rows = parseMembers(await api.get('members'));
	render();
}

const ELEVATING = 'Sign in again in the window that opens. This keeps Entra changes behind your password.';

async function runSync(only: string | null, tell: Say): Promise<void> {
	tell(ELEVATING);
	const asked = rows;
	markSyncing(true);
	try {
		const left = await elevated((elevatedApi) => elevatedApi.post<unknown>('entra/sync', syncBody(only)));
		await load();
		setReport(left, asked);
	} finally {
		markSyncing(false);
	}
	tell(only === null ? 'Everyone is synced with Entra.' : 'Synced with Entra.');
}

async function runCheck(tell: Say): Promise<void> {
	tell(ELEVATING);
	const asked = rows;
	setReport(await elevated((elevatedApi) => elevatedApi.get<unknown>('entra')), asked);
}

function setReport(raw: unknown, asked: readonly MemberRow[]): void {
	report = checkedReport(raw, asked);
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

const openings = new WeakMap<HTMLDialogElement, { readonly returnTo: () => HTMLElement | null }>();

/** Returns whether this opening is still the one on screen, so an action that finishes late cannot draw over a later one. */
function show(dialog: HTMLDialogElement, returnTo: () => HTMLElement | null): () => boolean {
	const opening = { returnTo };
	openings.set(dialog, opening);
	for (const feedback of dialog.querySelectorAll<HTMLElement>('.feedback')) sayIn(feedback)('');
	if (!dialog.open) dialog.showModal();
	dialog.querySelector<HTMLElement>('.sheet-head h2')?.focus();
	return () => dialog.open && openings.get(dialog) === opening;
}

const sayWhile =
	(live: () => boolean, inSheet: Say): Say =>
	(message, problem) =>
		(live() ? inSheet : say)(message, problem);

for (const dialog of [personDialog, addDialog, reportDialog]) {
	dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
	dialog.addEventListener('close', () => {
		const opener = openings.get(dialog)?.returnTo();
		(opener?.isConnected ? opener : search).focus();
	});
}

const reportSay = sayIn(byId('report-status', HTMLElement));
const reportActions = byId('report-actions', HTMLElement);

function openReport(): void {
	if (report.kind === 'unchecked') driftList.replaceChildren(el('li', {}, 'Entra has not been checked yet.'));
	show(reportDialog, () => attention.querySelector('[data-action="report"]'));
}

byId('sync-all', HTMLButtonElement).addEventListener('click', () => {
	if (!syncing) void attempt(reportActions, reportSay, () => runSync(null, reportSay));
});
byId('check-again', HTMLButtonElement).addEventListener('click', () =>
	void attempt(reportActions, reportSay, async () => {
		await runCheck(reportSay);
		reportSay('Checked Entra.');
	}),
);

const personSay = sayIn(byId('person-status', HTMLElement));
const addSay = sayIn(byId('add-status', HTMLElement));

function openPerson(userId: string): void {
	if (!rows.some((row) => row.userId === userId)) return;
	const live = show(personDialog, () => people.querySelector<HTMLElement>(`[data-user-id="${CSS.escape(userId)}"]`));
	drawPerson(userId, live);
}

/**
 * Keeps focus on the action just used, since a redraw replaces every element in the sheet. An action that finishes after
 * the sheet closed or moved to someone else redraws nothing and reports on the page status instead.
 */
function drawPerson(userId: string, live: () => boolean, promoteSync = false): void {
	const row = rows.find((candidate) => candidate.userId === userId);
	if (!row) return;
	const focused = document.activeElement instanceof HTMLElement && personBody.contains(document.activeElement) ? document.activeElement.dataset['action'] : undefined;
	const standing = standingOf(row, report);
	const tell = sayWhile(live, personSay);
	personTitle.textContent = row.email;

	const boxes = el('div', { class: 'boxes' });
	gameBoxes(boxes, row.games, 'person');
	const after = async (message: string, offerSync: boolean) => {
		await load();
		if (live()) drawPerson(userId, live, offerSync);
		tell(offerSync ? `${message} Sync with Entra so Entra matches.` : message);
	};
	const put = (state: MemberRow['state'], message: string) =>
		void attempt(personBody, tell, async () => {
			await api.put(`members/${row.userId}`, { state, games: grantOf(boxes) });
			await after(message, state !== row.state);
		});

	const linkText = row.linked ? 'Linked to their Entra account.' : 'Not synced yet. Their sign-in works only after a sync with Entra.';
	const syncPerson = () =>
		void attempt(personBody, tell, async () => {
			await runSync(row.userId, tell);
			if (live()) drawPerson(userId, live);
		});
	const sync = syncButton('Sync with Entra', syncPerson, needsSync(standing) || promoteSync ? 'primary' : 'quiet', 'sync');

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
}

function openAdd(opener: HTMLElement): void {
	drawAddForm(show(addDialog, () => opener));
	addBody.querySelector('input')?.focus();
}

function drawAddForm(live: () => boolean): void {
	const tell = sayWhile(live, addSay);
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
		void attempt(addBody, tell, async () => {
			const address = email.value.trim();
			const saved = await api.post<{ readonly userId: string }>('members', { email: address, games: grantOf(boxes) });
			await load();
			if (live()) drawAddSaved(saved.userId, address, live);
			else say(`Saved ${address}. Sync now so their sign-in works.`);
		});
	});
	addBody.replaceChildren(form);
}

function drawAddSaved(userId: string, address: string, live: () => boolean): void {
	const tell = sayWhile(live, addSay);
	addSay(`Saved ${address}. Sync now so their sign-in works.`);
	const row = rows.find((candidate) => candidate.userId === userId);
	const summary = row ? [el('p', {}, `Games: ${gamesSummary(row.games, games)}.`)] : [];
	const another = button('Add another', () => {
		addSay('');
		drawAddForm(live);
		addBody.querySelector('input')?.focus();
	}, 'quiet');
	const syncNow = syncButton(
		'Sync now',
		() =>
			void attempt(addBody, tell, async () => {
				await runSync(userId, tell);
				tell(`${address} is synced with Entra and can sign in now.`);
				if (!live()) return;
				const done = button('Done', () => addDialog.close());
				addBody.replaceChildren(el('p', { class: 'sheet-actions' }, done, another));
				done.focus();
			}),
		'primary',
		'sync',
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
