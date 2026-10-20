import { DEFAULT_ACCOUNTS, EMPTY_TARGET } from './accounts.ts';
import { migrateContent, type ContentRules } from './content.ts';
import { formatReport, type MigrationReport, type OldAccounts, type TargetWriter } from './model.ts';
import { buildMapping, migratePlayerData, parseCommand, type PortalRows } from './player-data.ts';

export type Options = {
	readonly suffix: string | null;
	readonly accounts: { readonly drawpad: string; readonly letterjoin: string };
};

export type Connection = {
	readonly from: OldAccounts;
	readonly to: TargetWriter | null;
	readPortal(): Promise<PortalRows>;
};

export type Io = {
	print(line: string): void;
	connect(options: Options): Promise<Connection>;
};

const SUFFIX = /^[a-z0-9]{5}$/;
const VALUE_FLAGS = ['--suffix', '--drawpad-account', '--letterjoin-account'];
const SWITCHES = ['--apply', '--dry-run', '--confirm-player-data', '--help'];

export const USAGE = `Options:
  --dry-run                     Report what would change. This is the default.
  --apply                       Write. Rows and files that already exist are left alone.
  --suffix <5 characters>       The suffix of the new accounts (g4k<game><suffix>). Without it a dry run plans against empty new accounts.
  --drawpad-account <name>      Old drawpad account, read only. Default ${DEFAULT_ACCOUNTS.drawpad}.
  --letterjoin-account <name>   Old letterjoin account, read only. Default ${DEFAULT_ACCOUNTS.letterjoin}.`;

export type Parsed = { readonly ok: true; readonly options: Options } | { readonly ok: false; readonly problem: string };

export function parseOptions(argv: readonly string[], allowed: readonly string[]): Parsed {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i] ?? '';
		if (VALUE_FLAGS.includes(flag)) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) return { ok: false, problem: `${flag} needs a value` };
			values.set(flag, value);
			i++;
		} else if (!SWITCHES.includes(flag) || !allowed.includes(flag)) return { ok: false, problem: `unknown option ${flag}` };
	}
	if (argv.includes('--apply') && argv.includes('--dry-run')) return { ok: false, problem: '--apply and --dry-run cannot be used together' };
	const suffix = values.get('--suffix') ?? null;
	if (suffix !== null && !SUFFIX.test(suffix)) return { ok: false, problem: '--suffix must be five lowercase letters or digits' };
	return {
		ok: true,
		options: {
			suffix,
			accounts: { drawpad: values.get('--drawpad-account') ?? DEFAULT_ACCOUNTS.drawpad, letterjoin: values.get('--letterjoin-account') ?? DEFAULT_ACCOUNTS.letterjoin },
		},
	};
}

export function describeFailure(error: unknown): string {
	const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
	if (status === 403) return 'Azure Storage refused the read (403). The signed-in account needs Storage Table Data Reader and Storage Blob Data Reader on the old drawpad and letterjoin accounts, and nothing was written.';
	return `Stopped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
}

function print(io: Io, report: MigrationReport): void {
	for (const line of formatReport(report)) io.print(line);
}

const SUFFIX_NOTE = 'No --suffix: planned against empty new accounts and an empty portal mapping.';

export async function runContent(argv: readonly string[], io: Io, rules: ContentRules): Promise<number> {
	const parsed = parseOptions(argv, ['--apply', '--dry-run', '--help']);
	if (!parsed.ok) {
		io.print(parsed.problem);
		return 2;
	}
	const apply = argv.includes('--apply');
	const { from, to } = await io.connect(parsed.options);
	if (apply && !to) {
		io.print('Refusing to write: --apply needs --suffix.');
		return 2;
	}
	if (!to) io.print(SUFFIX_NOTE);
	const report = apply && to ? await migrateContent({ mode: 'apply', target: to }, from, rules) : await migrateContent({ mode: 'dry-run', target: to ?? EMPTY_TARGET }, from, rules);
	print(io, report);
	return 0;
}

export async function runPlayerData(argv: readonly string[], io: Io): Promise<number> {
	const parsed = parseOptions(argv, SWITCHES);
	if (!parsed.ok) {
		io.print(parsed.problem);
		return 2;
	}
	const command = parseCommand(argv);
	const { from, to, readPortal } = await io.connect(parsed.options);
	const mapping = buildMapping(await readPortal());
	if (command.kind === 'apply' && !to) {
		io.print('Refusing to write: --apply needs --suffix.');
		return 2;
	}
	if (!to) io.print(SUFFIX_NOTE);
	const report =
		command.kind === 'apply' && to
			? await migratePlayerData({ mode: 'apply', mapping, target: to, confirmation: command.confirmation }, from)
			: await migratePlayerData({ mode: 'dry-run', mapping, target: to ?? EMPTY_TARGET }, from);
	print(io, report);
	io.print('Not migrated: drawpad names and time zones. Each child chooses them again on /welcome/.');
	io.print('Not migrated: who reviewed a letterjoin copy. Reviews keep reviewed, note and time.');
	if (command.kind === 'dry-run' && command.refusal) {
		io.print(command.refusal);
		return 2;
	}
	if (command.kind === 'dry-run') io.print('Nothing was written. Applying needs --apply --confirm-player-data, and waits for the owner.');
	return 0;
}
