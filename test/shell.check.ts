import type { AdminGameSession, AdminPortalSession, AdminSiteConfig } from '../apps/admin/shell/v1/index.ts';
import { enterAdmin } from '../apps/admin/shell/v1/index.ts';
import type { GamesSiteConfig, GameSession, PortalSession } from '../apps/games/shell/v1/index.ts';
import { enter, onRefusal } from '../apps/games/shell/v1/index.ts';

/**
 * Type-checked by `tsc -b` and never run. Each @ts-expect-error line is a claim about what the shells refuse; if a
 * line starts compiling, tsc reports the unused directive. The sketch's shell negatives, against the real shells.
 */

declare const gamesConfig: GamesSiteConfig;
declare const adminConfig: AdminSiteConfig;
declare const game: GameSession;
declare const home: PortalSession;
declare const adminGame: AdminGameSession;
declare const adminHome: AdminPortalSession;

// The games site config has no admin scope and no admin origin, so nothing on origin A can ask for an admin token.
// @ts-expect-error no admin scope
void gamesConfig.consoleScope;
// @ts-expect-error no elevation scope
void gamesConfig.elevateScope;
// @ts-expect-error no admin origin
void gamesConfig.adminApiOrigin;
// @ts-expect-error a literal config with an admin field is refused
const withAdmin: GamesSiteConfig = { ...gamesConfig, consoleScope: 'api://admin/admin.console' };

// The admin site has no games scope.
// @ts-expect-error no games scope on the admin site
void adminConfig.scope;

// A game session is a player and nothing more: no token, no oid, no email, no role, no elevation.
// @ts-expect-error no token
void game.token;
// @ts-expect-error no object id
void game.me.objectId;
// @ts-expect-error no email
void game.me.email;
// @ts-expect-error no role
void game.me.role;
// @ts-expect-error a game page cannot elevate
void game.elevated;
// @ts-expect-error only the portal page lists games
void game.games;
void home.games;

// A game's admin page can read and write through its api but cannot elevate; only the members page can.
// @ts-expect-error a game admin page cannot elevate
void adminGame.elevated;
void adminHome.elevated;

// enter and enterAdmin return the session that matches the page.
const gamePage: Promise<GameSession> = enter({ game: 'drawpad' });
const portalPage: Promise<PortalSession> = enter({ game: null });
// @ts-expect-error a game page is not a portal session
const wrongGamePage: Promise<PortalSession> = enter({ game: 'drawpad' });
const adminGamePage: Promise<AdminGameSession> = enterAdmin({ game: 'drawpad' });
const adminPortalPage: Promise<AdminPortalSession> = enterAdmin({ game: null });
// @ts-expect-error a game admin page is not the members page
const wrongAdminPage: Promise<AdminPortalSession> = enterAdmin({ game: 'drawpad' });
// @ts-expect-error the games shell does not export the admin entry
void import('../apps/games/shell/v1/index.ts').then((shell) => shell.enterAdmin);
// @ts-expect-error the admin shell does not export the games entry
void import('../apps/admin/shell/v1/index.ts').then((shell) => shell.enter);

// A refusal the shell does not know is a compile error, and a known one has an answer.
onRefusal('not_entitled');
// @ts-expect-error a string that is not a Refusal
onRefusal('teapot');

export { adminGamePage, adminPortalPage, gamePage, portalPage, withAdmin, wrongAdminPage, wrongGamePage };
