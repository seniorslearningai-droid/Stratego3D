import test from 'node:test';
import assert from 'node:assert/strict';
import { deploy, idx, move, newGame, viewFor } from '../js/game.js';
import { chooseMove, robotArmy } from '../js/robot.js';

// Small seeded random so the tests behave the same every run.
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function board(pieces, turn = 'blue') {
  const s = newGame();
  s.phase = 'play';
  s.ready = { red: true, blue: true };
  s.turn = turn;
  for (const [x, y, side, rank] of pieces) {
    s.board[idx(x, y)] = { id: s.nextId++, side, rank, seen: false, moved: true };
  }
  return s;
}

// Pretend the robot saw `id` in an earlier battle.
const remember = (s, id, side, rank) => s.log.push({ kind: 'attack', attacker: { id, side, rank }, defender: { id: 999, side: 'blue', rank: 'scout' }, result: 'attacker' });

test('the robot deploys a valid army', () => {
  const s = newGame();
  assert.ok(deploy(s, 'blue', robotArmy('blue')).ok);
});

test('the robot attacks a piece it knows it can beat', () => {
  const s = board([[4, 4, 'blue', 'colonel'], [4, 5, 'red', 'captain'], [0, 0, 'blue', 'flag'], [9, 9, 'red', 'flag'], [0, 9, 'red', 'scout']]);
  remember(s, s.board[idx(4, 5)].id, 'red', 'captain');
  assert.deepEqual(chooseMove(viewFor(s, 'blue'), 'blue', seeded(1)), { from: idx(4, 4), to: idx(4, 5) });
});

test('the robot keeps a valuable piece away from a known stronger one', () => {
  const s = board([[4, 4, 'blue', 'general'], [4, 5, 'red', 'marshal'], [0, 0, 'blue', 'flag'], [9, 9, 'red', 'flag']]);
  remember(s, s.board[idx(4, 5)].id, 'red', 'marshal');
  const m = chooseMove(viewFor(s, 'blue'), 'blue', seeded(2));
  assert.equal(m.from, idx(4, 4));
  assert.notEqual(m.to, idx(4, 5), 'does not attack the marshal');
  assert.notEqual(m.to, idx(3, 5));
  assert.notEqual(m.to, idx(5, 5));
});

test('the robot does not run into a known bomb with a non-miner', () => {
  const s = board([[4, 4, 'blue', 'captain'], [4, 5, 'red', 'bomb'], [0, 0, 'blue', 'flag'], [9, 9, 'red', 'flag'], [0, 9, 'red', 'scout']]);
  s.board[idx(4, 5)].moved = false;
  s.log.push({ kind: 'attack', attacker: { id: 999, side: 'blue', rank: 'major' }, defender: { id: s.board[idx(4, 5)].id, side: 'red', rank: 'bomb' }, result: 'defender' });
  const m = chooseMove(viewFor(s, 'blue'), 'blue', seeded(3));
  assert.notEqual(m.to, idx(4, 5));
});

test('two robots can play a whole game using only legal moves', () => {
  for (let g = 0; g < 5; g++) {
    const rng = seeded(100 + g);
    const s = newGame();
    deploy(s, 'red', robotArmy('red', rng));
    deploy(s, 'blue', robotArmy('blue', rng));
    let moves = 0;
    while (s.phase === 'play' && moves < 3000) {
      const m = chooseMove(viewFor(s, s.turn), s.turn, rng);
      assert.ok(m, 'always has a move while the game is on');
      const res = move(s, s.turn, m.from, m.to);
      assert.ok(res.ok, res.error);
      moves++;
    }
  }
});
