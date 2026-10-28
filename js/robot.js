// The computer opponent. It plays fair: it only ever sees its own view of the
// game (enemy ranks hidden) and remembers what battles showed it, from the log.

import { RANKS, RANK_KEYS, fight, legalTargets, other, randomArmy, remaining, xy } from './game.js';

// How much the robot cares about each piece.
const VALUE = {
  flag: 25, marshal: 10, general: 8, colonel: 6, major: 4.5, captain: 3,
  lieutenant: 2.2, sergeant: 1.6, miner: 2.5, scout: 1, spy: 4, bomb: 1.5,
};
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const FORWARD = { red: -1, blue: 1 };

export const robotArmy = (side, rng = Math.random) => randomArmy(side, rng);

// What the robot knows about the enemy: ranks it has seen (by piece id) and
// how many of each rank are still unaccounted for. `remembers(id)` says
// whether it kept a piece in mind; the last couple of moves it never forgets.
function knowledge(view, side, remembers = () => true) {
  const enemy = other(side);
  const known = new Map();
  for (const e of view.log) {
    const fresh = e.n >= view.moveCount - 2;
    if (e.kind === 'attack') {
      for (const f of [e.attacker, e.defender]) {
        if (f.side === enemy && (fresh || remembers(f.id))) known.set(f.id, f.rank);
      }
    } else if (e.kind === 'move' && e.side === enemy && e.rank && (fresh || remembers(e.id))) {
      known.set(e.id, e.rank);
    }
  }
  const pool = remaining(view, enemy);
  const onBoard = new Set(view.board.filter((p) => p && p.side === enemy).map((p) => p.id));
  for (const [id, rank] of known) {
    if (onBoard.has(id)) pool[rank] = Math.max(0, pool[rank] - 1);
    else known.delete(id);
  }
  let unmoved = 0;
  let enemyPieces = 0;
  let myMovable = 0;
  let myMiners = 0;
  let cheapest = Infinity;
  for (const p of view.board) {
    if (!p) continue;
    if (p.side === enemy) {
      enemyPieces++;
      if (!known.has(p.id) && !p.moved) unmoved++;
    } else if (!RANKS[p.rank].immobile) {
      myMovable++;
      if (p.rank === 'miner') myMiners++;
      cheapest = Math.min(cheapest, VALUE[p.rank]);
    }
  }
  const enemyImmobile = pool.bomb + pool.flag + [...known.values()].filter((r) => RANKS[r].immobile).length;
  const enemyMovable = Math.max(1, enemyPieces - enemyImmobile);
  return { known, pool, unmoved, myMovable, enemyMovable, myMiners, cheapest };
}

// Chances of each rank for an enemy piece. Pieces that have moved can't be
// bombs or the flag, so those belong to the pieces that haven't.
function odds(piece, k) {
  const seen = k.known.get(piece.id);
  if (seen) return { [seen]: 1 };
  const out = {};
  const immobile = k.pool.bomb + k.pool.flag;
  const movableTotal = RANK_KEYS.reduce((n, r) => n + (RANKS[r].immobile ? 0 : k.pool[r]), 0);
  const pImmobile = piece.moved || !k.unmoved ? 0 : Math.min(1, immobile / k.unmoved);
  for (const r of RANK_KEYS) {
    if (RANKS[r].immobile) out[r] = immobile ? (pImmobile * k.pool[r]) / immobile : 0;
    else out[r] = movableTotal ? ((1 - pImmobile) * k.pool[r]) / movableTotal : 0;
  }
  return out;
}

const outcomeValue = (mine, theirs) => {
  const res = fight(mine, theirs);
  if (res === 'attacker') return VALUE[theirs];
  if (res === 'defender') return -VALUE[mine];
  return VALUE[theirs] - VALUE[mine];
};

// How much `rank` standing on `sq` stands to lose if a neighbour attacks it.
function danger(view, side, k, rank, sq, ignore = -1) {
  const [x, y] = xy(sq);
  let worst = 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx > 9 || ny > 9) continue;
    const n = ny * 10 + nx;
    const e = view.board[n];
    if (!e || e.side === side || n === ignore) continue;
    let pBeat = 0;
    for (const [r, p] of Object.entries(odds(e, k))) {
      if (!p || RANKS[r].immobile) continue;
      const res = fight(r, rank);
      pBeat += p * (res === 'attacker' ? 1 : res === 'both' ? 0.5 : 0);
    }
    worst = Math.max(worst, pBeat);
  }
  return worst * VALUE[rank];
}

function scoreMove(view, side, k, from, to, rng, noise) {
  const piece = view.board[from];
  const target = view.board[to];
  const rank = piece.rank;
  let score = rng() * noise;
  // The longer the game runs, the bolder the robot gets, so it doesn't stall.
  // ...but only while it isn't running short of pieces that can move.
  const boldness = Math.min(1.2, view.moveCount / 250) * Math.min(1, k.myMovable / k.enemyMovable);
  // Don't just undo the last move.
  const last = view.recent[side].at(-1);
  if (last && last.id === piece.id && last.from === to) score -= 0.5;

  if (target) {
    const o = odds(target, k);
    let ev = 0;
    let pWin = 0;
    for (const [r, p] of Object.entries(o)) {
      if (!p) continue;
      ev += p * outcomeValue(rank, r);
      if (fight(rank, r) === 'attacker') pWin += p;
    }
    score += ev;
    // Leave pieces that haven't moved (likely bombs) to the miners.
    if (k.myMiners && rank !== 'miner' && VALUE[rank] >= 4) score -= (o.bomb || 0) * VALUE[rank];
    // Cheap pieces are worth spending to find out what something is.
    if (!k.known.has(target.id) && VALUE[rank] <= 1.6) score += 0.5;
    // Late on, send the cheapest pieces in (whatever they are by then).
    const expendable = VALUE[rank] <= Math.max(3, k.cheapest);
    if (!k.known.has(target.id) && expendable) {
      score += boldness * (k.myMiners ? Math.max(0, 1 - (o.bomb || 0) * 2.5) : 2.5);
    }
    score -= pWin * danger(view, side, k, rank, to, to) * 0.6;
    return score;
  }

  // Get out of trouble, and don't walk into it (cheap pieces may take the risk).
  const caution = VALUE[rank] <= 3 ? 0.9 - boldness * 0.6 : 0.9;
  score += (danger(view, side, k, rank, from) - danger(view, side, k, rank, to)) * caution;
  // Push forward, mostly with the expendable pieces.
  const rows = (xy(to)[1] - xy(from)[1]) * FORWARD[side];
  score += rows * (VALUE[rank] <= 3 ? 0.07 : 0.03);
  // Expendable pieces close in on the enemy.
  if (VALUE[rank] <= 3) score += (nearestEnemy(view, side, from) - nearestEnemy(view, side, to)) * (0.1 + boldness * 0.4);
  // Line up on enemy pieces we know we can beat.
  const [tx, ty] = xy(to);
  for (const [dx, dy] of DIRS) {
    const nx = tx + dx;
    const ny = ty + dy;
    if (nx < 0 || ny < 0 || nx > 9 || ny > 9) continue;
    const e = view.board[ny * 10 + nx];
    const seen = e && e.side !== side && k.known.get(e.id);
    if (seen && fight(rank, seen) === 'attacker') score += 0.25 * Math.min(VALUE[seen], 12);
  }
  return score;
}

function nearestEnemy(view, side, sq) {
  const [x, y] = xy(sq);
  let best = 99;
  view.board.forEach((p, i) => {
    if (!p || p.side === side) return;
    const [ex, ey] = xy(i);
    best = Math.min(best, Math.abs(ex - x) + Math.abs(ey - y));
  });
  return best;
}

// A number in [0, 1) that stays the same for a given game and piece.
function stableRandom(seed, id) {
  let h = (seed ^ Math.imul(id + 1, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Picks the robot's move from its own view of the game, or null if it has none.
// level runs from 1 (easiest) to 100 (hardest). Lower levels forget pieces
// they've seen, judge moves more loosely and now and then just play anything.
export function chooseMove(view, side, rng = Math.random, { level = 100, seed = 0 } = {}) {
  const skill = (Math.min(100, Math.max(1, level)) - 1) / 99;
  const memory = 0.2 + 0.8 * skill;
  const k = knowledge(view, side, (id) => stableRandom(seed, id) < memory);
  const moves = [];
  view.board.forEach((p, from) => {
    if (p && p.side === side) for (const to of legalTargets(view, from)) moves.push({ from, to });
  });
  if (!moves.length) return null;
  if (rng() < (1 - skill) ** 2 * 0.5) return moves[Math.floor(rng() * moves.length)];
  const noise = 0.05 + (1 - skill) ** 1.5 * 4;
  let best = null;
  for (const m of moves) {
    const score = scoreMove(view, side, k, m.from, m.to, rng, noise);
    if (!best || score > best.score) best = { ...m, score };
  }
  return { from: best.from, to: best.to };
}

// A short remark after a battle now and then, to keep things friendly.
const LINES = {
  won: ['Aha, got one!', 'Beep boop. That one is mine.', 'I had a feeling about that piece.'],
  lost: ['Ouch! Well played.', "Hmm, I didn't see that coming.", "Noted. I'll remember that one."],
  gameWon: ['Good game! Fancy a rematch?'],
  gameLost: ['You beat me fair and square. Good game!'],
};

export function robotRemark(event, side, rng = Math.random) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  if (event.winner) return pick(event.winner === side ? LINES.gameWon : LINES.gameLost);
  if (event.kind !== 'attack' || event.result === 'both' || rng() > 0.35) return null;
  const robotWon = (event.result === 'attacker' ? event.attacker : event.defender).side === side;
  return pick(robotWon ? LINES.won : LINES.lost);
}
