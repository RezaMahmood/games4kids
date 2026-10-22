import { definePlayApi } from '@g4k/sdk';
import manifest from '../../manifest.ts';

export const createPlayApi = definePlayApi(manifest, () => ({ routes: [] }));
