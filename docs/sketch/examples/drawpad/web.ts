/**
 * games/drawpad/web/src/main.tsx, without the JSX. boot.ts, auth/*, config.ts, ProfileName.tsx, AdminUsers.tsx
 * and TopBar's sign-out are deleted; the shell owns them. In the real file the import is '/shell/v1.js'.
 */
import { enter } from '../../shell';
import type { RoleOf } from '../../manifest';
import type manifest from './manifest';

type Picture = { id: string; title: string; kinds: string[] };

const session = await enter<RoleOf<typeof manifest>>({ game: 'drawpad' });
const pictures = await session.api.get<Picture[]>('pictures');
const showAdminSwitch = session.me.role === 'admin';
const outlineUrl = await session.api.objectUrl(`pictures/${pictures[0]?.id}/outline.png`);

export { outlineUrl, showAdminSwitch };
