import { enterAdmin, ready } from '/shell/v1/index.js';
import { render } from 'preact';
import '@fontsource/atkinson-hyperlegible/latin-400.css';
import '@fontsource/atkinson-hyperlegible/latin-700.css';
import '@fontsource/bricolage-grotesque/latin-500.css';
import '@fontsource/bricolage-grotesque/latin-700.css';
import '@fontsource/bricolage-grotesque/latin-800.css';
import '../../../play/web/src/styles.css';
import '../../../play/web/src/components/ui.css';
import { App } from './app';
import { configureApi, request } from './api';
import { recentJobs } from './admin/recentJobs';
import { configureBlobs } from '../../../play/web/src/blobs';

const session = await enterAdmin({ game: 'drawpad' });
configureApi(session.api);
configureBlobs(request);
const stopWaiting = recentJobs.subscribe(() => {
  if (recentJobs.get().kind === 'loading') return;
  stopWaiting();
  ready();
});
render(<App />, document.getElementById('app')!);
