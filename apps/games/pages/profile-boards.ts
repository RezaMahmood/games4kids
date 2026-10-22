import type { CatalogEntry } from '@g4k/sdk';
import { fieldsOf } from '../../shared/ids.ts';
import { ApiFailure, report, type ApiClient } from '../shell/v1/index.ts';

/** One switch's whole story. A load that fails leaves it `unavailable`, and a save that fails goes back to `ready` with the old value. */
type Switch =
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready'; readonly on: boolean; readonly message: string }
	| { readonly kind: 'saving'; readonly on: boolean }
	| { readonly kind: 'unavailable'; readonly message: string };

function optedIn(reply: unknown): boolean {
	const on = fieldsOf(reply)['optedIn'];
	if (typeof on !== 'boolean') throw new Error('a board switch answered without optedIn');
	return on;
}

const failure = (error: unknown, what: 'load' | 'save'): string =>
	error instanceof ApiFailure && error.code === 'game_paused' ? 'This game is having a rest. Try again later.' : `We could not ${what} this. Try again.`;

function render(row: { readonly input: HTMLInputElement; readonly note: HTMLElement }, state: Switch): void {
	row.input.disabled = state.kind !== 'ready';
	if ('on' in state) row.input.checked = state.on;
	row.note.textContent = state.kind === 'loading' ? 'Loading…' : state.kind === 'saving' ? 'Saving…' : state.kind === 'unavailable' || state.kind === 'ready' ? state.message : '';
}

const withBoard = (games: readonly CatalogEntry[]) => games.filter((game) => game.scoreboard);

/**
 * Reading `board/me` makes a game bring its copy of the child's name up to date, so this is how a rename reaches every
 * board at once. It does not wait for the games, and one that fails is reported without touching the rest.
 */
export function refreshBoards(games: readonly CatalogEntry[], gameApi: (game: CatalogEntry) => ApiClient): void {
	for (const game of withBoard(games)) gameApi(game).get('board/me').catch(report);
}

/**
 * One switch for each game whose board the child may join, each against that game's own player API. A game that
 * answers slowly or not at all holds up only its own switch.
 */
export function mountBoardSwitches(list: HTMLElement, games: readonly CatalogEntry[], gameApi: (game: CatalogEntry) => ApiClient): void {
	const rows = withBoard(games).map((game) => {
		const api = gameApi(game);
		const item = document.createElement('li');
		const label = document.createElement('label');
		label.className = 'board-switch';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.setAttribute('role', 'switch');
		const words = document.createElement('span');
		words.textContent = `Show my scores on the ${game.title} board`;
		const note = document.createElement('p');
		note.className = 'help';
		note.setAttribute('aria-live', 'polite');
		label.append(input, words);
		item.append(label, note);
		const row = { input, note };
		render(row, { kind: 'loading' });

		api.get('board/me').then(
			(reply) => render(row, { kind: 'ready', on: optedIn(reply), message: '' }),
			(error: unknown) => {
				report(error);
				render(row, { kind: 'unavailable', message: failure(error, 'load') });
			},
		);
		input.addEventListener('change', async () => {
			const wanted = input.checked;
			render(row, { kind: 'saving', on: wanted });
			try {
				render(row, { kind: 'ready', on: optedIn(await api.put('board/me', { on: wanted })), message: '' });
			} catch (error) {
				report(error);
				render(row, { kind: 'ready', on: !wanted, message: failure(error, 'save') });
			}
		});
		return item;
	});
	list.replaceChildren(...rows);
	list.closest('section')?.toggleAttribute('hidden', rows.length === 0);
}
