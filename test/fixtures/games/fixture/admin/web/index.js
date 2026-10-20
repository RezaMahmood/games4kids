import { enterAdmin, ready } from '/shell/v1/index.js';

const { api } = await enterAdmin({ game: 'fixture' });
const scores = await api.get('scores');
document.getElementById('scores').textContent = `${scores.length} scores`;
ready();
