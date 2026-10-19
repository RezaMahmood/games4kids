/**
 * games/letterjoin/admin/web/admin.js on the admin site. gate.js, auth.js and the Users tab go; the Activities,
 * Review, Practice, Progress and Settings tabs stay. The editor preview imports render.js and sheet.js from the play
 * part, which the admin site build copies. In the real file the import is '/shell/v1/index.js' on the admin origin.
 */
import { enterAdmin } from '../../shell';

const { api } = await enterAdmin({ game: 'letterjoin' });
const report = await api.get('practice');

export { report };
