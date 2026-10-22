import { defineAdminApi } from '@g4k/sdk';
import manifest from '../../manifest.ts';

export const createAdminApi = defineAdminApi(manifest, () => ({ routes: [] }));
