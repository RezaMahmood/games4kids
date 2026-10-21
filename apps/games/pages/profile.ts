import { ApiFailure, enter, ready, report } from '../shell/v1/index.ts';
import { nameMessage } from './name-message.ts';

function must<T extends HTMLElement>(id: string, kind: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof kind)) throw new Error(`profile page is missing #${id}`);
	return found;
}

const form = must('form', HTMLFormElement);
const nameInput = must('name', HTMLInputElement);
const errorText = must('error', HTMLElement);
const savedText = must('saved', HTMLElement);
const renameNote = must('rename-note', HTMLElement);
const saveButton = must('save', HTMLButtonElement);

const { me, api, renamed, canRenameToday } = await enter({ game: null, place: { kind: 'game', title: 'My profile' } });
let currentName = me.profile.displayName;
nameInput.value = currentName;
if (canRenameToday) nameInput.focus();
else lockForToday();
ready();

/** A child gets one rename a day, so after it the form stays shut until tomorrow rather than inviting a refusal. */
function lockForToday(): void {
	renameNote.textContent = 'You already changed your name today. You can change it again tomorrow.';
	nameInput.disabled = true;
	saveButton.disabled = true;
}

const isRenameTomorrow = (error: unknown) => error instanceof ApiFailure && error.code === 'rename_tomorrow';

function complain(message: string): void {
	errorText.textContent = message;
	nameInput.setAttribute('aria-invalid', 'true');
	nameInput.focus();
}

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	errorText.textContent = '';
	savedText.textContent = '';
	nameInput.removeAttribute('aria-invalid');
	const newName = nameInput.value.trim();
	if (newName === '') return complain('Type the name you want in games.');
	saveButton.disabled = true;
	saveButton.textContent = 'Saving…';
	let locked = false;
	try {
		await api.put('profile', { displayName: newName, timeZone: me.profile.timeZone });
		nameInput.value = newName;
		locked = newName !== currentName;
		currentName = newName;
		renamed(newName);
		savedText.textContent = `Saved. Your name in games is ${newName}.`;
	} catch (error) {
		locked = isRenameTomorrow(error);
		if (locked) nameInput.value = currentName;
		else {
			report(error);
			complain(nameMessage(error));
		}
	} finally {
		saveButton.textContent = 'Save';
		if (locked) lockForToday();
		else saveButton.disabled = false;
	}
});
