import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isKindName } from '@g4k/host';

test('ordinary names pass, including real names that hold a flagged word inside them', () => {
	for (const name of ['Ada', 'Mia Rose', "O'Brien", 'Anna-Lee', 'Scunthorpe', 'Cassie', 'Dickens', 'Hancock', 'Cockburn', 'Sussex', 'Nigel', 'Hannah', 'Sebastian', 'Class Clown', 'Poppy', 'Alexis']) {
		assert.equal(isKindName(name), true, `${name} is allowed`);
	}
});

test('swear words and insults aimed at people are refused, in any case', () => {
	for (const name of ['shit', 'SHIT', 'Fuck', 'bitch', 'Mr Shit', 'cunt', 'nigger', 'idiot', 'Stupid', 'LOSER', 'dumb', 'Ugly', 'fat', 'smelly', 'hate', 'Big Loser', 'You are Stupid']) {
		assert.equal(isKindName(name), false, `${name} is refused`);
	}
});

test('lookalike letters and spaced-out letters do not get a word past the check', () => {
	for (const name of ['sh1t', 'a55', 'b1tch', 'd1ck', 'n1gger', 'f u c k', 's h i t', 'f-u-c-k']) {
		assert.equal(isKindName(name), false, `${name} is refused`);
	}
});

test('an insult is refused only as a whole word', () => {
	for (const name of ['Fatima', 'Dumbo', 'Hateful', 'Stupidly Good']) assert.equal(isKindName(name), true, `${name} is allowed`);
	assert.equal(isKindName('Ugly Duckling'), false);
});

test('real given names and surnames the dataset flags are let through, as whole words only', () => {
	for (const name of ['Dickson', 'Analise', 'Annalee', 'Fagan', 'Fagin', 'Fukui', 'Cummings', 'Peniston', 'Pissarro', 'ANNALEE', 'Mr Dickson', 'Anna Fagan']) {
		assert.equal(isKindName(name), true, `${name} is allowed`);
	}
	for (const name of ['Dick', 'Dicky', 'Big Dick', 'Dickhead', 'Dickwad', 'Dickless', 'Mrdick', 'd1ck', 'Dickson shit']) {
		assert.equal(isKindName(name), false, `${name} is refused`);
	}
});

test('words that are only insults stay refused', () => {
	for (const name of ['Ass', 'Sex', 'Hooker', 'ass', 'SEX']) assert.equal(isKindName(name), false, `${name} is refused`);
});

test('mild swearing, hate figures, slurs and threats the dataset misses are refused, in lookalike letters too', () => {
	for (const name of ['Hell', 'Damn', 'Crap', 'Bloody', 'Bugger', 'Nazi', 'Hitler', 'H1tler', 'Adolf Hitler', 'Spaz', 'Pikey', 'Nonce', 'Pedo', 'Paedo', 'Dumbass', 'Butthead', 'Poo Head', 'Kys', 'Kill Yourself', 'Die', 'Kill', 'h3ll', 'cr4p']) {
		assert.equal(isKindName(name), false, `${name} is refused`);
	}
});

test('a word broken up by spaces or marks is read joined, however it is split', () => {
	for (const name of ['sh i t', 's hit', 'f uck', 'fu ck', 'h i t l e r', 'c r a p', 'b.i.t.c.h', 'p_o_o']) {
		assert.equal(isKindName(name), false, `${name} is refused`);
	}
});

test('names that hold a short refused word inside them still pass', () => {
	for (const name of ['Michelle', 'Shelly', 'Hello Kitty', 'Scrappy', 'Diego', 'Killian', 'Nazia', 'Dieter', 'Pedro', 'Torpedo', 'Announce', 'Poole', 'Bumble', 'Weekes', 'Damian', 'Hellen']) {
		assert.equal(isKindName(name), true, `${name} is allowed`);
	}
});

test('two real names side by side are not read as one word', () => {
	for (const name of ['Sana Ali', 'Hassan Ali', 'Ana Lee', 'Anna-Lily', 'Sebastian Allen', 'Dylan Ali', 'Teddy Kelly', 'Mr Dickson', 'Al Ali']) {
		assert.equal(isKindName(name), true, `${name} is allowed`);
	}
});

test('short surnames beside a first name pass, however they are joined', () => {
	for (const first of ['Anna', 'Ana', 'Dana', 'Lana', 'Jana', 'Sana', 'Hasan', 'Lan']) {
		for (const last of ['Le', 'Li', 'Ly', 'Lu', 'La', 'Al']) {
			for (const name of [`${first} ${last}`, `${first}-${last}`, `${last} ${first}`]) assert.equal(isKindName(name), true, `${name} is allowed`);
		}
	}
	for (const name of ['Cu Mia', 'Cu Max', 'Cu Minh', 'Cu Mai', 'Sana Al Ali']) assert.equal(isKindName(name), true, `${name} is allowed`);
});

test('real names from many backgrounds that hold a flagged word pass', () => {
	for (const name of ['Harshit', 'Shitanshu', 'Dikshit', 'Bich Ngoc', 'Thi Bich', 'Fukuda', 'Shitara', 'Analia', 'Cumhur', 'Pakistan', 'Raccoon', 'Gunn', 'Hoang', 'Butt', 'Kit', 'King', 'Kirk', 'Poppy']) {
		assert.equal(isKindName(name), true, `${name} is allowed`);
	}
});

test('slurs, hate words and threats a child might try are refused', () => {
	for (const name of [
		'Paki', 'Paki Boy', 'P4ki', 'Pak1', 'spic', 'sp1c', 'coon', 'c00n', 'gook', 'g00k', 'wog', 'w0g', 'Raghead', 'Towelhead', 'Golliwog', 'Jungle Bunny', 'Batty Boy', 'Spacker', 'Lesbo', 'Homo', 'Shemale',
		'Naziboy', 'Heil', 'Sieg Heil', 'White Power', '1488', 'Fuhrer', 'Fuehrer', 'KKK', 'Kkk Boy', 'K K K', 'k.k.k',
		'Murderer', 'Murder', 'Suicide', 'Stab', 'Stabber', 'Gunman', 'Shoot You', 'Bomb', 'Bomber', 'Terrorist', 'Jihad', 'Groomer', 'Killer', 'Killa', 'IKillYou', 'IHateYou',
	]) {
		assert.equal(isKindName(name), false, `${name} is refused`);
	}
});

test('swearing split into longer pieces, respelled, or with an ending added is refused', () => {
	for (const name of [
		'fuc ker', 'fuc king', 'shi thead', 'dic khead', 'coc ksucker', 'bit chy', 'bas tard', 'bast ard', 'wan ker', 'bol lock', 'bol locks', 'ret ard', 'ret arded', 'tos ser', 'slu tty', 'hit ler', 'pa ki', 'Poopy', 'Poop Head',
		'fuq', 'phuck', 'fcuk', 'shyt', 'biatch', 'beyotch', 'azz', 'sl00t', 'frick', 'frig', 'stfu', 'wtf', 'gtfo', 'lmfao',
		'buttface', 'Butt Head', 'jackass', 'bellend', 'knobhead', 'tosser', 'minger', 'slag', 'skank', 'Fatty', 'IdiotFace', 'Bumhole', 'b u m', 'Pee Pee', 'Wee Wee', 'Poop', 'pus sy', 'puss y',
		'Hellboy', 'Damnit', 'Crappy', 'Pedobear', 'Peadophile', 'Fart', 'Farty', 'Nude', 'Naked', 'Horny', 'Hoe', 'Thot', 'Incel',
	]) {
		assert.equal(isKindName(name), false, `${name} is refused`);
	}
});
