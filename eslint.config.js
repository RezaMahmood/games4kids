import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const GAME_ROOTS = ['games/*', 'test/fixtures/games/*'];
const inGames = (path) => GAME_ROOTS.map((root) => `${root}/${path}`);

/** What no part of any game may import. A game gets storage handles, settings and tokens from its platform, and writes no auth or telemetry code. */
const GAME_BANS = [
	{ group: ['@azure/*'], message: 'A game gets handles and tokens from its platform, never an Azure SDK, client or credential.' },
	{ group: ['@g4k/host', '@g4k/host/*'], message: 'A game builds on @g4k/sdk only.' },
	{ group: ['jose'], message: 'A game writes no auth code; the host verifies every token.' },
	{ group: ['@opentelemetry/*', 'applicationinsights'], message: 'A game writes no telemetry code; the host owns it.' },
	{ group: ['process', 'node:process'], message: 'A game reads settings from its platform, never the environment.' },
];

const banned = (...extra) => ['error', { patterns: [...GAME_BANS, ...extra] }];

export default defineConfig(
	{ ignores: ['.claude/**', '**/dist/**', 'dev/generated/**', 'test/generated/**', 'docs/sketch/**', '**/.gen/**'] },
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
		},
	},
	{
		files: ['tools/**/*.mjs', '*.js'],
		languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
	},
	{
		files: ['packages/host/src/**/*.ts'],
		ignores: ['packages/host/src/adapters/**', 'packages/host/src/runtime.ts'],
		rules: {
			'no-restricted-imports': ['error', { patterns: [{ group: ['@azure/*', '@opentelemetry/*'], message: 'Only the adapters and runtime.ts import an Azure or OpenTelemetry SDK.' }] }],
		},
	},
	{
		files: ['packages/host/src/adapters/**/*.ts'],
		ignores: ['packages/host/src/adapters/functions.ts'],
		rules: {
			'no-restricted-imports': ['error', { patterns: [{ group: ['@azure/functions'], message: 'Only adapters/functions.ts imports @azure/functions.' }] }],
		},
	},
	{
		files: inGames('**/*.ts'),
		rules: {
			'no-restricted-imports': banned(),
			'no-restricted-globals': ['error', { name: 'process', message: 'A game reads settings from its platform, never the environment.' }],
		},
	},
	{
		files: inGames('manifest.ts'),
		rules: { 'no-restricted-imports': banned({ regex: '^\\.', message: 'A manifest is data only, so gen and infra load it without loading game code.' }) },
	},
	{
		files: inGames('data/**/*.ts'),
		rules: { 'no-restricted-imports': banned({ group: ['**/play/**', '**/admin/**'], message: 'The data part imports neither the play part nor the admin part.' }) },
	},
	{
		files: inGames('play/**/*.ts'),
		rules: { 'no-restricted-imports': banned({ group: ['**/admin/**'], message: 'Nothing imports the admin part.' }) },
	},
	{
		files: inGames('admin/**/*.ts'),
		rules: { 'no-restricted-imports': banned({ group: ['**/play/api/**'], message: "The admin part may import the play part's pure modules, never its API." }) },
	},
);
