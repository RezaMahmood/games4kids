import type { AdminCatalogEntry } from '@g4k/sdk';
import { el } from '../../../shared/dom.ts';

export type AdminBarState = {
	readonly email: string;
	readonly games: readonly AdminCatalogEntry[];
	signOut(): void;
};

/** The dark strip on every admin page: members, each game's admin pages, who is signed in, and sign out. */
export class AdminBar extends HTMLElement {
	show(state: AdminBarState): void {
		const signOut = el('button', { type: 'button', class: 'g4k-button quiet' }, 'Sign out');
		signOut.addEventListener('click', state.signOut);
		const links = [el('a', { href: '/' }, 'Members'), ...state.games.filter((game) => game.hasAdmin).map((game) => el('a', { href: game.path }, game.title))];
		this.replaceChildren(
			el(
				'header',
				{ class: 'g4k-bar admin' },
				el('a', { class: 'brand', href: '/' }, 'Games admin'),
				el('nav', { 'aria-label': 'Admin' }, ...links, el('span', { class: 'who' }, state.email), signOut),
			),
		);
	}
}

export function mountAdminBar(state: AdminBarState): void {
	if (!customElements.get('admin-bar')) customElements.define('admin-bar', AdminBar);
	const bar = document.querySelector('admin-bar') ?? document.body.insertBefore(document.createElement('admin-bar'), document.body.firstChild);
	if (bar instanceof AdminBar) bar.show(state);
}
