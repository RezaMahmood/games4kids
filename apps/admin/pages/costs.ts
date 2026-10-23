import { ApiFailure, enterAdmin, ready, report, whileLoading } from '../shell/v1/index.ts';
import { el } from '../../shared/dom.ts';
import { barPercent, callsLabel, COST_BYS, parseCostReport, periodName, quietLine, spentPeriods, totalLine, type AreaCost, type CostBy, type CostReport } from './costs-model.ts';

const { api } = await enterAdmin({ game: null });

function byId(id: string): HTMLElement {
	const found = document.getElementById(id);
	if (!found) throw new Error(`costs page is missing #${id}`);
	return found;
}
const status = byId('status');
const switcher = byId('by');
const content = byId('report');

function say(message: string, problem = false): void {
	status.textContent = message;
	status.classList.toggle('problem', problem);
}

function explain(error: unknown): string {
	if (error instanceof ApiFailure) return error.problems.length > 0 ? `${error.message} ${error.problems.join(' ')}` : error.message;
	return 'Something went wrong. Nothing was changed.';
}

const costLine = (cost: { readonly text: string; readonly calls: number }) => el('span', { class: 'cost' }, el('strong', {}, cost.text), el('span', { class: 'calls' }, callsLabel(cost.calls)));

let titles: ReadonlyMap<string, string> = new Map();

/** The area rows read "Story words" with the game beneath, since two games may each have a "Pictures". */
function areaRow(area: AreaCost): HTMLLIElement {
	return el('li', { class: 'cost-row' }, el('span', { class: 'what' }, el('span', { class: 'name' }, area.label), el('span', { class: 'sub' }, titles.get(area.game) ?? area.game)), costLine(area));
}

function periodRow(period: CostReport['periods'][number], by: CostBy, most: number): HTMLLIElement {
	const fill = el('span', { class: 'fill' });
	fill.style.width = `${barPercent(period.total.microUsd, most)}%`;
	const bar = el('span', { class: 'bar', 'aria-hidden': 'true' }, fill);
	const name = periodName(period.period, by);
	const summary = el('summary', { class: 'cost-row' }, el('span', { class: 'what' }, el('span', { class: 'name' }, name), bar), costLine(period.total));
	const details = el('details', {}, summary, el('ul', { class: 'costs inner', 'aria-label': `Cost by area, ${name}` }, ...period.areas.map(areaRow)));
	return el('li', {}, details);
}

function draw(data: CostReport): void {
	titles = new Map(data.games.map((game) => [game.game, game.title]));
	byId('periods-title').textContent = `By ${data.by}`;
	byId('total').textContent = totalLine(data);
	const spent = data.total.calls > 0;
	byId('empty').hidden = spent;
	byId('breakdown').hidden = !spent;
	byId('games').replaceChildren(
		...data.games.map((game) => el('li', { class: 'cost-row' }, el('span', { class: 'what' }, el('span', { class: 'name' }, game.title)), costLine(game))),
	);
	byId('areas').replaceChildren(...data.areas.map(areaRow));
	const shown = spentPeriods(data.periods);
	const most = Math.max(0, ...shown.map((period) => period.total.microUsd));
	byId('periods').replaceChildren(...shown.map((period) => periodRow(period, data.by, most)));
	const quiet = quietLine(data.by, data.periods.length - shown.length);
	byId('quiet').textContent = quiet ?? '';
	byId('quiet').hidden = !spent || quiet === null;
	byId('periods-title').hidden = !spent;
	byId('periods').hidden = !spent;
	content.hidden = false;
}

let latest = 0;

async function show(by: CostBy, first = false): Promise<void> {
	const mine = ++latest;
	for (const button of switcher.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset['by'] === by));
	say(first ? 'Loading costs.' : '');
	try {
		const request = api.get<unknown>(`costs?by=${by}`);
		const data = parseCostReport(await (first ? request : whileLoading(request)));
		if (mine !== latest) return;
		draw(data);
		say('');
	} catch (error) {
		if (mine !== latest) return;
		report(error);
		say(explain(error), true);
	}
}

for (const button of switcher.querySelectorAll('button')) {
	const by = COST_BYS.find((one) => one === button.dataset['by']);
	if (by) button.addEventListener('click', () => void show(by));
}

await show('day', true);
ready();
