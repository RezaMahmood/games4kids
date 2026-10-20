import { enter } from '/shell/v1/index.js';
import { render } from 'preact';
import '@fontsource/atkinson-hyperlegible/latin-400.css';
import '@fontsource/atkinson-hyperlegible/latin-700.css';
import '@fontsource/bricolage-grotesque/latin-500.css';
import '@fontsource/bricolage-grotesque/latin-700.css';
import '@fontsource/bricolage-grotesque/latin-800.css';
import './styles.css';
import './components/ui.css';
import { App } from './app';
import { configureApi, request } from './api';
import { configureBlobs } from './blobs';

const session = await enter({ game: 'drawpad' });
configureApi(session.api);
configureBlobs(request);
render(<App name={session.me.profile.displayName} />, document.getElementById('app')!);
