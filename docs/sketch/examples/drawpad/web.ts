/**
 * games/drawpad/play/web/src/main.tsx without the JSX. boot.ts, auth/*, config.ts, ProfileName.tsx, the Admin*
 * screens, admin/ and stencil/ leave the play part; the last four move to games/drawpad/admin/web. In the real file
 * the import is '/shell/v1/index.js'.
 */
import { enter } from '../../shell';
import type { Picture } from './data';

const session = await enter({ game: 'drawpad' });
const pictures = await session.api.get<Picture[]>('pictures');
const outlineUrl = await session.api.objectUrl(`pictures/${pictures[0]?.id}/outline.png`);
await session.api.post('usage/heartbeat', { seconds: 60 }, { keepalive: true });

export { outlineUrl };
