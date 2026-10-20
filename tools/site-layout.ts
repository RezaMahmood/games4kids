import { join, resolve } from 'node:path';

export type SiteKind = 'games' | 'admin';

/**
 * Where each URL on a site comes from. The dev server resolves a request from these and the deploy job copies them into
 * the folder it uploads, so both serve one layout:
 *   /shell/v1/*       the compiled shell of this site
 *   /shared/*         the compiled shared modules, then shell.css and the vendored MSAL from apps/shared
 *   /shared/tokens.css  design/tokens.json, generated
 *   /g/<id>/*         that game's play/web (games site) or admin/web (admin site)
 *   everything else   the compiled page scripts, then the pages' html under apps/<site>/pages
 * Earlier directories win.
 */
export const shellDir = (repo: string, kind: SiteKind) => join(repo, 'dist/apps', kind, 'shell/v1');
export const sharedDirs = (repo: string) => [join(repo, 'dist/apps/shared'), join(repo, 'apps/shared')];
export const tokensFile = (repo: string) => join(repo, 'design/.gen/tokens.css');
export const gameWebDir = (repo: string, gamesRoot: string, kind: SiteKind, id: string) => join(resolve(repo, gamesRoot), id, kind === 'games' ? 'play/web' : 'admin/web');
export const pageDirs = (repo: string, kind: SiteKind) => [join(repo, 'dist/apps', kind, 'pages'), join(repo, 'apps', kind, 'pages')];
export const swaConfigFile = (repo: string, kind: SiteKind) => join(repo, 'apps', kind, 'staticwebapp.config.json');
export const catalogFile = (repo: string, kind: SiteKind) => join(repo, 'apps', kind, '.gen/catalog.json');
