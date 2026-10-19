/**
 * games/letterjoin/web/app.js and admin.js. gate.js, auth.js, redirect.html and vendor/msal are deleted. The
 * header in index.html becomes <portal-bar title="Letter Tracing" back="/"> with the practice pill and the
 * score chip in its center slot. In the real files the import is '/shell/v1.js'.
 */
import { enter } from '../../shell';

const { api, me } = await enter({ game: 'letterjoin' });
const groups = await api.get<{ level: string; items: { id: string; title: string }[] }[]>('activities');
await api.put(`activities/${groups[0]?.items[0]?.id}/result`, { score: 92, timeMs: 41000, hard: false });

const admin = await enter({ game: 'letterjoin', requires: 'admin' });
const report = await admin.api.get('manage/practice');

export { me, report };
