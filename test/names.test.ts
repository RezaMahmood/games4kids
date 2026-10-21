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
