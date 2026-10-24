import { enterAdmin, ready } from '/shell/v1/index.js';

await enterAdmin({ game: 'colourmatch' });
ready();
