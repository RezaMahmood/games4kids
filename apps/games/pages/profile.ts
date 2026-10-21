import { enter, ready, report } from '../shell/v1/index.ts';
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
showRenameNote(!canRenameToday);
nameInput.value = currentName;
ready();
nameInput.focus();

function showRenameNote(renamedToday: boolean): void {
	renameNote.textContent = renamedToday ? 'You already changed your name today. You can change it again tomorrow.' : '';
}

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
	try {
		await api.put('profile', { displayName: newName, timeZone: me.profile.timeZone });
		nameInput.value = newName;
		if (newName !== currentName) showRenameNote(true);
		currentName = newName;
		renamed(newName);
		savedText.textContent = `Saved. Your name in games is ${newName}.`;
	} catch (error) {
		report(error);
		complain(nameMessage(error));
	} finally {
		saveButton.disabled = false;
		saveButton.textContent = 'Save';
	}
});
