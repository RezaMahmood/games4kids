import { enter, ready } from '../shell/v1/index.ts';

const status = document.getElementById('status');
const cards = document.getElementById('cards');

const { games } = await enter({ game: null });

if (!status || !cards) throw new Error('home.html is missing its status or its list');

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
			const link = document.createElement('a');
			link.className = 'card';
			link.href = game.path;
			link.append(icon, title, summary);
			const item = document.createElement('li');
			item.append(link);
			return item;
		}),
	);
}
ready();
