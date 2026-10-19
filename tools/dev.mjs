// The local stack: node --conditions=source tools/dev.mjs [--fixtures] [--port-base 4280] [--azurite <connection string>]
//
// One process serves the fake IdP (tokens for both audiences, auth_time stamped when its popup runs, the OBO grant),
// a fake Graph, every Function app through serveWithNode with the real token checks, and the two sites on two ports
// so they stay two origins, each with the headers its staticwebapp.config.json sets. Storage is in memory unless an
// Azurite connection string is given. Sign in as admin@example.com on the admin site; any other address is a child.
import { parseArgs } from 'node:util';
import { startDevStack } from '../dev/stack.ts';

const { values } = parseArgs({
  options: {
    fixtures: { type: 'boolean', default: false },
    'port-base': { type: 'string', default: '4280' },
    azurite: { type: 'string' },
  },
});

const azuriteConnectionString = values.azurite ?? process.env.AZURITE_CONNECTION_STRING;
const stack = await startDevStack({
  fixtures: values.fixtures,
  portBase: Number(values['port-base']),
  ...(azuriteConnectionString ? { azuriteConnectionString } : {}),
});

console.log(`dev: games site   ${stack.gamesOrigin}/`);
console.log(`dev: admin site   ${stack.adminOrigin}/   sign in as ${stack.adminEmail}`);
console.log(`dev: api          ${stack.apiOrigin}/api/`);
console.log(`dev: fake IdP     ${stack.idp.origin}/   (self-signed certificate, accept it once in the browser)`);
console.log(`dev: storage      ${azuriteConnectionString ? 'Azurite' : 'memory'}${values.fixtures ? ', fixture games' : ''}`);
console.log('dev: ready');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void stack.close().then(() => process.exit(0)));
}
