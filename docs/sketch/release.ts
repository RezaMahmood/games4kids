/**
 * tools/release.mjs. How one game ships without shipping the others.
 *
 * Every pipeline that builds something the site or an app runs publishes it as an immutable artifact, then moves
 * its own pin to it. The `web-release` job reads every pin, checks the contract rule, and deploys the one Static Web
 * App from the pinned artifacts only. A game release changes only that game's pins, so every other file on the site
 * is byte-identical to the previous release.
 *
 * The store is the `releases` container in the portal storage account, g4kportal<suffix>:
 *   artifacts/<path from artifactPath>     immutable, written with If-None-Match: *
 *   pins/<path from pinPath>.json          Pin, one writer each, inside that owner's GitHub concurrency group
 *   manifests/<run>.json                   ReleaseManifest, one per web-release run, never rewritten
 *
 * Concurrency, per separate-before-serializing-shared-state. No two owners share a pin: drawpad's pipeline writes
 * pins/drawpad/*, letterjoin's writes pins/letterjoin/*, so two games releasing at once never write the same object.
 * Two runs of the same owner are serialized by the GitHub concurrency group `release-<owner>`. web-release writes no
 * pin. It runs in the group `web-release`, where a newer pending run replaces an older pending one, which loses
 * nothing, because a run reads the pins when it starts and so sees every pin written before it.
 */

import type { Brand, GameId } from './manifest';
import type { CatalogEntry } from './registry';

/** A full 40-character commit id. Minted only by parseGitSha. */
export type GitSha = Brand<string, 'GitSha'>;

/** Hex SHA-256 of the artifact's bytes. */
export type Digest = Brand<string, 'Digest'>;

/** `https://<host>`, no path. A Function app's origin, read from the app after its deploy. */
export type AppOrigin = Brand<string, 'AppOrigin'>;

/**
 * @g4k/sdk's major and minor, which is the contract between a game and the platform: the shell's browser API, the
 * game API types, the wire error shape, and the portal-table rows a game app reads. Each artifact records the version
 * it was built against. See `compatible` for the rule.
 */
export type ContractVersion = { readonly major: number; readonly minor: number };

type ArtifactBase = { readonly sha: GitSha; readonly digest: Digest; readonly contract: ContractVersion };

/** The Function apps that ship from this repo. Each game has its own, plus the portal app and the admin app. */
export type AppOwner = GameId | 'portal' | 'admin';

/** One immutable build output. The kind fixes which slot of a release it can fill. */
export type ArtifactRef =
	/** dist/shell/v<contract.major>/: index.js and theme.css. The shell implements contract.major at contract.minor. */
	| (ArtifactBase & { readonly kind: 'shell' })
	/** The portal pages: /, /welcome/, /admin/, redirect.html. */
	| (ArtifactBase & { readonly kind: 'site' })
	/** One game's pages for /g/<game>/, plus its catalog entry (minus apiBaseUrl) and CSP extension. */
	| (ArtifactBase & { readonly kind: 'web'; readonly game: GameId; readonly entry: Omit<CatalogEntry, 'apiBaseUrl' | 'contract'> })
	/** A Function app package: the game's api bundled with @g4k/host, or the portal app, or the admin app. */
	| (ArtifactBase & { readonly kind: 'app'; readonly owner: AppOwner });

export type ArtifactOf<K extends ArtifactRef['kind']> = Extract<ArtifactRef, { readonly kind: K }>;

/** artifacts/shell/v1/<sha>.tar.gz, artifacts/site/<sha>.tar.gz, artifacts/<game>/web/<sha>.tar.gz, artifacts/<owner>/app/<sha>.zip */
export function artifactPath(ref: ArtifactRef): string {
	throw new Error('not implemented');
}

/**
 * One owner's live version of one kind, and the one before it, so a rollback is one step. pins/shell/v<major>,
 * pins/portal/site, pins/<game>/web, pins/<owner>/app.
 */
export type Pin<A extends ArtifactRef> = {
	readonly current: A;
	readonly previous: A | null;
	/** ISO time and GitHub run id of the write, for the audit trail. */
	readonly at: string;
	readonly run: string;
};

/** An app pin also carries where the app answers, so the catalog can give the shell each game's API base URL. */
export type AppPin = Pin<ArtifactOf<'app'>> & { readonly origin: AppOrigin };

export function pinPath(ref: ArtifactRef): string {
	throw new Error('not implemented');
}

/** Blob access as the job's deploy identity. Conditional writes are the store's, not the caller's, to get right. */
export type ReleaseStore = {
	get(path: string): Promise<{ readonly bytes: Uint8Array; readonly etag: string } | undefined>;
	/** If-None-Match: *. false when the path exists. */
	putIfAbsent(path: string, bytes: Uint8Array): Promise<boolean>;
	put(path: string, bytes: Uint8Array): Promise<void>;
	list(prefix: string): Promise<readonly string[]>;
	remove(path: string): Promise<void>;
};

/**
 * Upload once. A rerun for the same sha finds the artifact and compares digests: 'present' when equal, 'conflict'
 * when the build was not reproducible, which fails the job instead of overwriting what a pin may point at.
 */
export function publishArtifact(store: ReleaseStore, ref: ArtifactRef, bytes: Uint8Array): Promise<'written' | 'present' | 'conflict'> {
	throw new Error('not implemented');
}

/**
 * Move the owner's pin to `ref`. Reads the pin first: already current is 'unchanged', so a rerun does nothing.
 * Otherwise writes { current: ref, previous: old current }. A web or app ref is refused with its problems when the
 * pinned shells do not serve its contract, so an incompatible build never becomes live.
 */
export function pinArtifact<A extends ArtifactRef>(store: ReleaseStore, ref: A, extra: A extends ArtifactOf<'app'> ? { readonly origin: AppOrigin } : {}): Promise<'pinned' | 'unchanged' | { readonly problems: readonly ReleaseProblem[] }> {
	throw new Error('not implemented');
}

/** Swap current and previous. The app job then redeploys the pinned package; web-release follows for web pins. */
export function rollbackPin(store: ReleaseStore, path: string): Promise<'rolled-back' | 'no-previous'> {
	throw new Error('not implemented');
}

/** Delete pins/<game>/*, so the next web-release drops the game. Its Azure resources and data stay. */
export function retireGame(store: ReleaseStore, game: GameId): Promise<void> {
	throw new Error('not implemented');
}

export type AppRelease = { readonly artifact: ArtifactOf<'app'>; readonly origin: AppOrigin };

export type GameRelease = { readonly id: GameId; readonly web: ArtifactOf<'web'>; readonly app: AppRelease };

/** What one web-release deployed, assembled from the pins at the start of the run and stored under manifests/. */
export type ReleaseManifest = {
	readonly run: string;
	/** One per served major, newest first. The newest is the current major; a second one is the previous major. */
	readonly shells: readonly [ArtifactOf<'shell'>] | readonly [ArtifactOf<'shell'>, ArtifactOf<'shell'>];
	readonly site: ArtifactOf<'site'>;
	readonly portal: AppRelease;
	readonly admin: AppRelease;
	readonly games: readonly GameRelease[];
};

export type ReleaseProblem =
	| { readonly kind: 'missing-pin'; readonly path: string }
	/** Built against a minor the pinned shell of that major does not reach yet. */
	| { readonly kind: 'contract-ahead'; readonly owner: string; readonly built: ContractVersion; readonly served: ContractVersion }
	/** A major that is neither the current nor the previous one. */
	| { readonly kind: 'contract-unsupported'; readonly owner: string; readonly built: ContractVersion }
	/** A game's pages and its app must share a major, because the shell's ApiClient parses that app's errors. */
	| { readonly kind: 'game-split-major'; readonly game: GameId; readonly web: ContractVersion; readonly app: ContractVersion };

/**
 * The compatibility rule, the one place it lives. An artifact built against M.m runs in a release when:
 *   1. M is the current major (the newest pinned shell) or the previous one, and
 *   2. for a web artifact, the pinned shell vM is at minor n >= m.
 * Minors only add: a new optional field, a new function, a new route. Anything else is a new major, served at
 * /shell/v<M+1>/ beside /shell/vM/, while the portal app and @g4k/host keep reading M's shapes until no pin uses M.
 */
export function compatible(shells: ReleaseManifest['shells'], built: ArtifactRef): readonly ReleaseProblem[] {
	throw new Error('not implemented');
}

/**
 * Pure. Reads every pin, includes a game only when both its web and app pins exist, and re-runs `compatible` for
 * each, because a shell rollback can race a game pin. Any problem fails the run and the site stays as it was.
 */
export function assembleRelease(run: string, pins: {
	readonly shells: readonly Pin<ArtifactOf<'shell'>>[];
	readonly site: Pin<ArtifactOf<'site'>> | undefined;
	readonly apps: readonly AppPin[];
	readonly webs: readonly Pin<ArtifactOf<'web'>>[];
}): ReleaseManifest | { readonly problems: readonly ReleaseProblem[] } {
	throw new Error('not implemented');
}

/**
 * Lays out dist/site from the manifest's artifacts and writes the four files no artifact owns: catalog.json
 * (each game's entry plus apiBaseUrl from its app pin and its contract), config.json, staticwebapp.config.json
 * (routes and per-game CSP, whose connect-src lists every app origin), and release.json (the manifest itself).
 */
export function renderSite(manifest: ReleaseManifest, unpacked: (ref: ArtifactRef) => string, outDir: string): Promise<void> {
	throw new Error('not implemented');
}

export function parseGitSha(raw: string): GitSha | null {
	throw new Error('not implemented');
}
