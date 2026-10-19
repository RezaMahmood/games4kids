import { enter } from '/shell/v1/index.js';

const { api } = await enter({ game: 'puzzle' });
const reply = await api.post('hello', {});
document.getElementById('hello').textContent = `Puzzle says hello ${reply.hello}`;
