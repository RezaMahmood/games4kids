import { registerWithFunctions } from '@g4k/host/functions';
import { portalAppFromEnv } from '@g4k/host/runtime';
import { registered } from '../.gen/registered.ts';

registerWithFunctions(portalAppFromEnv(registered, process.env));
