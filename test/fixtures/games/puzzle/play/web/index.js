import { enter, ready } from '/shell/v1/index.js';

const { api } = await enter({ game: 'puzzle' });
try {
  const reply = await api.post('hello', {});
  document.getElementById('hello').textContent = `Puzzle says hello ${reply.hello}`;
} finally {
  ready();
}
