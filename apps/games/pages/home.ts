import { enter, ready, type PortalSession } from '../shell/v1/index.ts';

const status = document.getElementById('status');
const cards = document.getElementById('cards');

const { games } = await enter({ game: null });

if (!status || !cards) throw new Error('home.html is missing its status or its list');

/** A paused game is no link, so it cannot be opened or focused, and its label says why rather than only the grey. */
function cardFor(game: PortalSession['games'][number]): HTMLElement {
	if (!game.paused) {
		const link = document.createElement('a');
		link.className = 'card';
		link.href = game.path;
		return link;
	}
	const card = document.createElement('div');
	card.className = 'card paused';
	card.ariaDisabled = 'true';
	return card;
}

if (games.length === 0) {
	status.textContent = 'No games are switched on for you yet. Ask your grown-up.';
} else {
	status.textContent = '';
	cards.replaceChildren(
		...games.map((game) => {
			const icon = document.createElement('img');
			icon.src = `${game.path}${game.icon}`;
			icon.alt = '';
			icon.width = 72;
			icon.height = 72;
			const title = document.createElement('span');
			title.className = 'title';
			title.textContent = game.title;
			const summary = document.createElement('span');
			summary.className = 'summary';
			summary.textContent = game.summary;
			const card = cardFor(game);
			card.append(icon, title, summary);
			if (game.paused) {
				const label = document.createElement('span');
				label.className = 'paused-label';
				label.textContent = 'Paused for now';
				card.append(label);
			}
			const item = document.createElement('li');
			item.append(card);
			return item;
		}),
	);
}
ready();
