import { VIKING_ROUND } from '../../dev/fake-foundry.ts';
import { parseRoundContent, type RoundContent } from '../../games/timedetectives/data/content.ts';

/** A round as an admin or the model sends it. */
export const LINDISFARNE = VIKING_ROUND;

function parsed(): RoundContent {
	const round = parseRoundContent(LINDISFARNE);
	if (!round.ok) throw new Error(round.problems.join('; '));
	return round.value;
}

export const ROUND = parsed();
