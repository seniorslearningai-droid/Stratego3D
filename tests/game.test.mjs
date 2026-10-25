import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMY_SIZE, RANKS, deploy, fight, homeSquares, idx, isValidArmy, legalTargets,
  move, newGame, randomArmy, remaining, resign, viewFor, xy,
} from '../js/game.js';

// A game already in play with only the pieces we place.
function board(pieces, turn = 'red') {
  const s = newGame();
  s.phase = 'play';
  s.ready = { red: true, blue: true };
  s.turn = turn;
  for (const [x, y, side, rank] of pieces) {
    s.board[idx(x, y)] = { id: s.nextId++, side, rank, revealed: false, moved: false };
  }
  return s;
}

test('a full army has 40 pieces', () => {
  assert.equal(ARMY_SIZE, 40);
});

test('random armies are valid with the flag on the back row', () => {
  for (const side of ['red', 'blue']) {
    for (let i = 0; i < 50; i++) {
      const army = randomArmy(side);
      assert.ok(isValidArmy(army));
      const flagSq = homeSquares(side)[army.indexOf('flag')];
      assert.equal(xy(flagSq)[1], side === 'red' ? 9 : 0);
    }
  }
});

test('combat rules', () => {
  assert.equal(fight('spy', 'marshal'), 'attacker');
  assert.equal(fight('marshal', 'spy'), 'attacker');
  assert.equal(fight('spy', 'scout'), 'defender');
  assert.equal(fight('miner', 'bomb'), 'attacker');
  assert.equal(fight('marshal', 'bomb'), 'defender');
  assert.equal(fight('scout', 'flag'), 'attacker');
  assert.equal(fight('captain', 'captain'), 'both');
  assert.equal(fight('general', 'colonel'), 'attacker');
});

test('lakes block movement and scouts slide until blocked', () => {
  const s = board([[2, 6, 'red', 'scout'], [2, 9, 'red', 'bomb'], [5, 6, 'red', 'scout'], [5, 2, 'blue', 'sergeant']]);
  // Scout under the left lake can only go sideways and back.
  const t1 = legalTargets(s, idx(2, 6)).map((i) => xy(i).join(','));
  assert.ok(!t1.includes('2,5'));
  assert.ok(t1.includes('0,6') && t1.includes('4,6') && t1.includes('2,8'));
  assert.ok(!t1.includes('2,9'), 'cannot land on own piece');
  // Scout in the centre lane runs up to and can attack the sergeant.
  const t2 = legalTargets(s, idx(5, 6)).map((i) => xy(i).join(','));
  assert.ok(t2.includes('5,3') && t2.includes('5,2'));
  assert.ok(!t2.includes('5,1'), 'cannot jump over pieces');
  assert.deepEqual(legalTargets(s, idx(2, 9)), [], 'bombs never move');
});

test('non-scouts move one square', () => {
  const s = board([[4, 6, 'red', 'marshal']]);
  assert.equal(legalTargets(s, idx(4, 6)).length, 4);
});

test('moves are validated', () => {
  const s = board([[4, 6, 'red', 'captain'], [4, 3, 'blue', 'captain']]);
  assert.equal(move(s, 'blue', idx(4, 3), idx(4, 4)).ok, false, 'not blue turn');
  assert.equal(move(s, 'red', idx(4, 6), idx(4, 4)).ok, false, 'two squares');
  assert.equal(move(s, 'red', idx(4, 3), idx(4, 4)).ok, false, 'not your piece');
  assert.equal(move(s, 'red', idx(4, 6), idx(4, 5)).ok, true);
  assert.equal(s.turn, 'blue');
});

test('attacks resolve and record losses', () => {
  const s = board([[4, 5, 'red', 'captain'], [4, 4, 'blue', 'lieutenant'], [0, 0, 'blue', 'scout'], [9, 9, 'red', 'scout']]);
  const r = move(s, 'red', idx(4, 5), idx(4, 4));
  assert.equal(r.event.result, 'attacker');
  assert.equal(s.board[idx(4, 4)].rank, 'captain');
  assert.equal(s.board[idx(4, 4)].revealed, true);
  assert.deepEqual(s.lost.blue, ['lieutenant']);
  assert.equal(remaining(s, 'blue').lieutenant, RANKS.lieutenant.count - 1);
});

test('equal ranks remove both pieces', () => {
  const s = board([[4, 5, 'red', 'major'], [4, 4, 'blue', 'major'], [0, 0, 'blue', 'scout'], [9, 9, 'red', 'scout']]);
  move(s, 'red', idx(4, 5), idx(4, 4));
  assert.equal(s.board[idx(4, 4)], null);
  assert.equal(s.board[idx(4, 5)], null);
});

test('bombs stay after destroying an attacker', () => {
  const s = board([[4, 5, 'red', 'general'], [4, 4, 'blue', 'bomb'], [0, 0, 'blue', 'scout'], [9, 9, 'red', 'scout']]);
  move(s, 'red', idx(4, 5), idx(4, 4));
  assert.equal(s.board[idx(4, 4)].rank, 'bomb');
  assert.equal(s.board[idx(4, 4)].revealed, true);
  assert.equal(s.board[idx(4, 5)], null);
});

test('capturing the flag wins', () => {
  const s = board([[4, 5, 'red', 'scout'], [4, 4, 'blue', 'flag'], [0, 0, 'blue', 'sergeant']]);
  const r = move(s, 'red', idx(4, 5), idx(4, 4));
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'red');
  assert.equal(s.reason, 'flag');
  assert.equal(r.event.winner, 'red');
});

test('a player with no legal moves loses', () => {
  const s = board([[4, 5, 'red', 'captain'], [4, 4, 'blue', 'scout'], [0, 0, 'blue', 'flag'], [9, 9, 'red', 'flag']]);
  move(s, 'red', idx(4, 5), idx(4, 4)); // blue's only mover dies
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'red');
  assert.equal(s.reason, 'stuck');
});

test('two-square rule stops endless shuttling', () => {
  const s = board([[0, 6, 'red', 'sergeant'], [9, 3, 'blue', 'sergeant'], [9, 0, 'blue', 'flag'], [0, 9, 'red', 'flag']]);
  const a = idx(0, 6);
  const b = idx(0, 7);
  const c = idx(9, 3);
  const d = idx(9, 2);
  move(s, 'red', a, b); move(s, 'blue', c, d);
  move(s, 'red', b, a); move(s, 'blue', d, c);
  move(s, 'red', a, b); move(s, 'blue', c, d);
  assert.ok(!legalTargets(s, b).includes(a), 'fourth shuttle is blocked');
  assert.ok(legalTargets(s, b).includes(idx(1, 7)), 'other moves still fine');
});

test('views hide enemy ranks until revealed, and show all at the end', () => {
  const s = newGame();
  assert.ok(deploy(s, 'red', randomArmy('red')).ok);
  assert.equal(deploy(s, 'red', randomArmy('red')).ok, false, 'cannot deploy twice');
  assert.equal(deploy(s, 'blue', ['flag']).ok, false, 'invalid army rejected');
  assert.ok(deploy(s, 'blue', randomArmy('blue')).ok);
  assert.equal(s.phase, 'play');

  const redView = viewFor(s, 'red');
  const blueSq = homeSquares('blue')[0];
  const redSq = homeSquares('red')[0];
  assert.equal(redView.board[blueSq].rank, null);
  assert.ok(redView.board[redSq].rank);
  redView.board[redSq].rank = 'x';
  assert.notEqual(s.board[redSq].rank, 'x', 'views are copies');

  resign(s, 'blue');
  assert.equal(s.winner, 'red');
  assert.ok(viewFor(s, 'red').board[blueSq].rank, 'everything revealed after the game');
});
