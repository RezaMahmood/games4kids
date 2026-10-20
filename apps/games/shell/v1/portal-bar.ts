import { el } from '../../../shared/dom.ts';

export type BarState = {
	readonly displayName: string;
	switchPlayer(): void;
	signOut(): void;
};

/**
 * The strip on every games-site page: home, who is playing, and the two ways out. Light DOM, so the shell's
 * stylesheet reaches it. A page may place `<portal-bar>` itself; otherwise the shell puts one first in the body.
 */
export class PortalBar extends HTMLElement {
	show(state: BarState): void {
		const button = (label: string, run: () => void) => {
			const element = el('button', { type: 'button', class: 'g4k-button quiet' }, label);
			element.addEventListener('click', run);
			return element;
		};
		this.replaceChildren(
			el(
				'header',
				{ class: 'g4k-bar' },
				el('a', { class: 'brand', href: '/' }, 'Games'),
				el('nav', { 'aria-label': 'Player' }, el('span', { class: 'who' }, 'Playing as ', el('strong', {}, state.displayName)), button('Switch player', state.switchPlayer), button('Sign out', state.signOut)),
			),
		);
	}
}

export function mountPortalBar(state: BarState): void {
	if (!customElements.get('portal-bar')) customElements.define('portal-bar', PortalBar);
	const bar = document.querySelector('portal-bar') ?? document.body.insertBefore(document.createElement('portal-bar'), document.body.firstChild);
	if (bar instanceof PortalBar) bar.show(state);
}
