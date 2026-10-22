import { parseRoundContent, type RoundContent } from '../../games/timedetectives/data/content.ts';

/** A round as an admin or the model sends it: Vikings at Lindisfarne in AD 793. */
export const LINDISFARNE = {
	title: 'The raid on Lindisfarne',
	full: 'The monks of a quiet island priory were singing their morning prayers. Out at sea, long ships with striped sails cut through the waves. The year was AD 793, and the island was Lindisfarne, off the coast of Northumbria. The ships carried Viking raiders from across the North Sea. They ran up the beach and into the church. They took silver cups, jewelled books and food. Some monks hid in the fields until the ships sailed away. News of the raid spread across England. People had never seen anything like it. Many say the Viking Age began on that cold June day.',
	brief: 'The bells were still ringing for morning prayers when the lookout saw sails on the grey horizon. The wind smelled of salt and seaweed. Nobody on the little island knew who was coming, or why. By lunchtime, nothing there would ever be the same again.',
	pictureAlt: 'Longships with striped sails land on a rocky island beach beside a small stone church.',
	questions: [
		{ kind: 'who', answer: 'Vikings', decoys: ['Romans', 'Normans', 'Ancient Egyptians'], hint: 'Look for who the ships carried across the North Sea.' },
		{ kind: 'where', answer: 'Lindisfarne', decoys: ['Hadrian\'s Wall', 'Stonehenge', 'The Tower of London'], hint: 'The story names the island off Northumbria.' },
		{ kind: 'when', answer: 'AD 793', decoys: ['about 3000 BC', 'AD 43', 'AD 1066'], hint: 'Find the year in the third sentence.' },
	],
};

function parsed(): RoundContent {
	const round = parseRoundContent(LINDISFARNE);
	if (!round.ok) throw new Error(round.problems.join('; '));
	return round.value;
}

export const ROUND = parsed();
