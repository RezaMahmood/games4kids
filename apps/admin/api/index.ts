import { registerWithFunctions } from '@g4k/host/functions';
import { adminAppFromEnv } from '@g4k/host/runtime';
import { grantable, modules } from '../.gen/modules.ts';

registerWithFunctions(adminAppFromEnv(grantable, modules, process.env));
