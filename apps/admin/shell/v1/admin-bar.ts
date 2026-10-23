import type { AdminCatalogEntry } from '@g4k/sdk';
import { el } from '../../../shared/dom.ts';

export type AdminBarState = {
	readonly email: string;
	readonly games: readonly AdminCatalogEntry[];
	signOut(): void;
};

type Destination = { readonly label: string; readonly href: string };

const MEMBERS: Destination = { label: 'Members', href: '/' };
const COSTS: Destination = { label: 'Costs', href: '/costs/' };
const PAUSE: Destination = { label: 'Pause and resume games', href: '/games/' };

function isCurrent(href: string): boolean {
	const path = location.pathname;
	return href === '/' ? path === '/' || path === '/index.html' : path.startsWith(href);
}

function link(to: Destination): HTMLAnchorElement {
	const a = el('a', { href: to.href }, to.label);
	if (isCurrent(to.href)) a.setAttribute('aria-current', 'page');
	return a;
}

type Menu = { readonly root: HTMLElement; close(): void };

/** A button that shows a panel. Opening moves focus into the panel; Escape closes it and returns focus to the button; a click or Tab outside closes it; opening one closes the others. */
function menu(name: string, toggleContent: readonly (Node | string)[], toggleLabel: string, panelChildren: readonly Node[], align: 'start' | 'end', menus: Menu[]): Menu {
	const panelId = `bar-menu-${name}`;
	const toggle = el('button', { type: 'button', class: 'menu-toggle', 'aria-expanded': 'false', 'aria-controls': panelId, 'aria-label': toggleLabel, 'data-menu-toggle': name }, ...toggleContent);
	const panel = el('div', { class: `menu-panel ${align}`, id: panelId, hidden: '' }, ...panelChildren);
	const root = el('div', { class: 'menu' }, toggle, panel);
	const set = (open: boolean) => {
		toggle.setAttribute('aria-expanded', String(open));
		panel.hidden = !open;
	};
	const self: Menu = { root, close: () => set(false) };
	menus.push(self);
	toggle.addEventListener('click', () => {
		const open = toggle.getAttribute('aria-expanded') !== 'true';
		for (const other of menus) if (other !== self) other.close();
		set(open);
		if (open) panel.querySelector<HTMLElement>('a, button')?.focus();
	});
	root.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape' || panel.hidden) return;
		event.stopPropagation();
		set(false);
		toggle.focus();
	});
	root.addEventListener('focusout', (event) => {
		if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) set(false);
	});
	document.addEventListener('pointerdown', (event) => {
		if (event.target instanceof Node && !root.contains(event.target)) set(false);
	});
	return self;
}

function initial(email: string): string {
	return (email.trim()[0] ?? '?').toUpperCase();
}

function build(state: AdminBarState): HTMLElement {
	const menus: Menu[] = [];
	const games: Destination[] = state.games.filter((game) => game.hasAdmin).map((game) => ({ label: game.title, href: game.path }));
	const currentGame = games.find((game) => isCurrent(game.href));
	const gamesMenu = menu(
		'games',
		['Games', el('span', { class: 'caret', 'aria-hidden': 'true' })],
		currentGame ? `Games, now on ${currentGame.label}` : 'Games',
		[
			el('ul', { class: 'menu-list' }, el('li', {}, link(PAUSE))),
			el('p', { class: 'menu-heading', id: 'bar-games-heading' }, 'Game admin pages'),
			el('ul', { class: 'menu-list', 'aria-labelledby': 'bar-games-heading' }, ...games.map((game) => el('li', {}, link(game)))),
		],
		'start',
		menus,
	);
	if (currentGame || isCurrent(PAUSE.href)) gamesMenu.root.classList.add('holds-current');
	const signOut = el('button', { type: 'button', class: 'g4k-button quiet' }, 'Sign out');
	signOut.addEventListener('click', state.signOut);
	const accountMenu = menu(
		'account',
		[el('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(state.email))],
		`Account, signed in as ${state.email}`,
		[el('p', { class: 'menu-note' }, 'Signed in as', el('br'), el('strong', {}, state.email)), signOut],
		'end',
		menus,
	);
	return el('header', { class: 'g4k-bar admin' }, el('a', { class: 'brand', href: '/' }, 'Games admin'), el('nav', { 'aria-label': 'Admin' }, link(MEMBERS), link(COSTS), gamesMenu.root), accountMenu.root);
}

/** The dark strip on every admin page: members, costs, a Games menu holding every game's admin pages, and an account menu with sign out. */
export class AdminBar extends HTMLElement {
	show(state: AdminBarState): void {
		this.replaceChildren(build(state));
	}
}

export function mountAdminBar(state: AdminBarState): void {
	if (!customElements.get('admin-bar')) customElements.define('admin-bar', AdminBar);
	const bar = document.querySelector('admin-bar') ?? document.body.insertBefore(document.createElement('admin-bar'), document.body.firstChild);
	if (bar instanceof AdminBar) bar.show(state);
}
