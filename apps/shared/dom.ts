type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Readonly<Record<string, string>> = {}, ...children: readonly Child[]): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
	element.append(...children);
	return element;
}

export type ScreenAction = { readonly label: string; run(): void | Promise<void> };

/** Ends a page's first load: the overlay on body[aria-busy] lifts and any inert region takes input again. */
export function ready(): void {
	document.body.removeAttribute('aria-busy');
	for (const region of document.querySelectorAll('[inert]')) region.removeAttribute('inert');
}

/** A full-page message from the shell: not invited, not switched on, or a failure. Replaces the page and takes focus. */
export function showScreen(heading: string, message: string, actions: readonly ScreenAction[] = []): void {
	ready();
	const title = el('h1', { tabindex: '-1' }, heading);
	const buttons = actions.map((action) => {
		const button = el('button', { type: 'button', class: 'g4k-button' }, action.label);
		button.addEventListener('click', () => void action.run());
		return button;
	});
	document.body.replaceChildren(el('main', { class: 'g4k-screen' }, title, el('p', {}, message), ...(buttons.length > 0 ? [el('p', { class: 'g4k-actions' }, ...buttons)] : [])));
	title.focus();
}

export function stylesheet(href: string): void {
	if (!document.head.querySelector(`link[href="${href}"]`)) document.head.append(el('link', { rel: 'stylesheet', href }));
}
