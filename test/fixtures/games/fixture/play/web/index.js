import { enter, ready } from '/shell/v1/index.js';

const { api, me, storage } = await enter({ game: 'fixture' });

const hello = document.getElementById('hello');
const levels = document.getElementById('levels');
const problem = document.getElementById('problem');

hello.textContent = `Hello ${me.profile.displayName}`;
storage.set('visits', String(Number(storage.get('visits') ?? 0) + 1));

async function look() {
  problem.textContent = '';
  try {
    const found = await api.get('levels');
    levels.textContent = `${found.length} levels`;
  } catch (error) {
    problem.textContent = error.message;
  }
}

document.getElementById('refresh').addEventListener('click', look);
await look();
ready();
