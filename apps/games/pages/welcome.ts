import { ApiFailure, enterWelcome, ready, whileLoading } from '../shell/v1/index.ts';
import { safeReturn } from './return-to.ts';

function must<T extends HTMLElement>(id: string, kind: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof kind)) throw new Error(`welcome page is missing #${id}`);
	return found;
}

const form = must('form', HTMLFormElement);
const nameInput = must('name', HTMLInputElement);
const zoneSelect = must('zone', HTMLSelectElement);
const errorText = must('error', HTMLElement);

const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = Intl.supportedValuesOf('timeZone');
zoneSelect.replaceChildren(
	...(zones.includes(mine) ? zones : [mine, ...zones]).map((zone) => {
		const option = document.createElement('option');
		option.value = zone;
		option.textContent = zone.replaceAll('_', ' ');
		option.selected = zone === mine;
		return option;
	}),
);

const { api } = await enterWelcome();
ready();
nameInput.focus();

function complain(message: string): void {
	errorText.textContent = message;
	nameInput.setAttribute('aria-invalid', 'true');
	nameInput.focus();
}

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	errorText.textContent = '';
	nameInput.removeAttribute('aria-invalid');
	const displayName = nameInput.value.trim();
	if (displayName === '') return complain('Type the name you want in games.');
	try {
		await whileLoading(api.put('profile', { displayName, timeZone: zoneSelect.value }));
		location.assign(safeReturn(new URLSearchParams(location.search).get('return'), location.origin));
	} catch (error) {
		if (!(error instanceof ApiFailure)) return complain('We could not save your name. Try again.');
		complain(error.code === 'name_taken' ? 'Someone already has that name. Try another.' : (error.problems[0] ?? error.message));
	}
});
