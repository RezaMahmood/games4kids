import { ApiFailure, enterAdmin, ready } from '../shell/v1/index.ts';
import { el } from '../../shared/dom.ts';
import { fieldsOf } from '../../shared/ids.ts';

const { api, games: catalog } = await enterAdmin({ game: null });

function byId(id: string): HTMLElement {
	const found = document.getElementById(id);
	if (!found) throw new Error(`games page is missing #${id}`);
	return found;
}
const status = byId('status');
const list = byId('games');

function say(message: string, problem = false): void {
	status.textContent = message;
	status.classList.toggle('problem', problem);
}

function explain(error: unknown): string {
	if (error instanceof ApiFailure) return error.problems.length > 0 ? `${error.message} ${error.problems.join(' ')}` : error.message;
	return 'Something went wrong. Nothing was changed.';
}

function pausedById(raw: unknown): ReadonlyMap<string, boolean> {
	return new Map((Array.isArray(raw) ? raw : []).flatMap((entry) => {
		const { id, paused } = fieldsOf(entry);
		return typeof id === 'string' && typeof paused === 'boolean' ? [[id, paused] as const] : [];
	}));
}

/** Updates the row in place, so the button keeps focus after a change. */
function row(id: string, title: string, initial: boolean): HTMLLIElement {
	let paused = initial;
	const badge = el('span', { class: 'badge', id: `${id}-state` });
	const toggle = el('button', { type: 'button', class: 'g4k-button quiet', 'aria-describedby': badge.id });
	const draw = () => {
		badge.textContent = paused ? 'Paused' : 'Available';
		badge.classList.toggle('paused', paused);
		toggle.textContent = paused ? 'Make available' : 'Pause';
	};
	toggle.addEventListener('click', async () => {
		toggle.disabled = true;
		toggle.textContent = 'Saving…';
		try {
			const saved = fieldsOf(await api.put<unknown>(`games/${id}`, { paused: !paused }))['paused'];
			if (typeof saved !== 'boolean') throw new Error('PUT games answered no state');
			paused = saved;
			say(paused ? `Paused ${title}. Players see it greyed out.` : `${title} is available again. Players can open it.`);
		} catch (error) {
			say(explain(error), true);
		} finally {
			toggle.disabled = false;
			draw();
			toggle.focus();
		}
	});
	draw();
	return el('li', { class: 'game' }, el('span', { class: 'title' }, title), badge, toggle);
}

try {
	const paused = pausedById(await api.get<unknown>('games'));
	const rows = catalog.flatMap((game) => {
		const state = paused.get(game.id);
		return state === undefined ? [] : [row(game.id, game.title, state)];
	});
	list.replaceChildren(...(rows.length > 0 ? rows : [el('li', { class: 'empty' }, 'No games are registered yet.')]));
	say('');
} catch (error) {
	say(explain(error), true);
}
ready();
