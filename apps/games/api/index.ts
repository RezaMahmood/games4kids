import { registerWithFunctions } from '@g4k/host/functions';
import { portalAppFromEnv } from '@g4k/host/runtime';

registerWithFunctions(portalAppFromEnv(process.env));
