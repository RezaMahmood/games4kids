import { games } from '../dev/generated/games.ts';
import { runAdminConformance, runPlayConformance } from './conformance.ts';
import { games as fixtures } from './generated/fixtures.ts';

for (const game of [...games, ...fixtures]) {
	game.use(({ manifest, play, admin }) => {
		runPlayConformance(manifest, play);
		if (admin) runAdminConformance(manifest, admin);
	});
}
