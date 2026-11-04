// The computer opponent. It plays fair: it only ever sees its own view of the
// game (enemy ranks hidden) and remembers what battles showed it, from the log.

import { RANKS, RANK_KEYS, fight, isLake, legalTargets, other, randomArmy, remaining, xy } from './game.js';

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
function knowledge(view, side, remembers = () => true, peek = null) {
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
  // Above level 100 the robot is allowed a look at some hidden pieces.
  if (peek) for (const [id, rank] of peek) known.set(id, rank);
  const pool = remaining(view, enemy);
  const onBoard = new Set(view.board.filter((p) => p && p.side === enemy).map((p) => p.id));
  for (const [id, rank] of known) {
    if (onBoard.has(id)) pool[rank] = Math.max(0, pool[rank] - 1);
    else known.delete(id);
  }
  let unmoved = 0;
  let flagWeights = 0;
  let enemyPieces = 0;
  let myMovable = 0;
  let myMiners = 0;
  let cheapest = Infinity;
  let myFlag = null;
  let enemyMarshal = null;
  let flagGuess = null; // the unmoved enemy piece most likely to be their flag
  let knownFlag = null;
  view.board.forEach((p, sq) => {
    if (!p) return;
    if (p.side === enemy) {
      enemyPieces++;
      if (!known.has(p.id) && !p.moved) {
        unmoved++;
        flagWeights += flagWeight(enemy, sq);
        if (flagGuess == null || flagWeight(enemy, sq) > flagWeight(enemy, flagGuess)) flagGuess = sq;
      }
      if (known.get(p.id) === 'marshal') enemyMarshal = sq;
      if (known.get(p.id) === 'flag') knownFlag = sq;
    } else if (p.rank === 'flag') {
      myFlag = sq;
    } else if (!RANKS[p.rank].immobile) {
      myMovable++;
      if (p.rank === 'miner') myMiners++;
      cheapest = Math.min(cheapest, VALUE[p.rank]);
    }
  });
  const enemyImmobile = pool.bomb + pool.flag + [...known.values()].filter((r) => RANKS[r].immobile).length;
  const enemyMovable = Math.max(1, enemyPieces - enemyImmobile);
  if (knownFlag != null) flagGuess = knownFlag;
  return {
    enemy, known, pool, unmoved, flagWeights, myMovable, enemyMovable, myMiners, cheapest, myFlag, enemyMarshal, flagGuess,
    flagKnown: knownFlag != null,
  };
}

// Flags are usually hidden at the back, so unmoved pieces there are likelier.
function flagWeight(side, sq) {
  const fromBack = side === 'red' ? 9 - xy(sq)[1] : xy(sq)[1];
  return [3, 1.5, 0.7, 0.35][fromBack] ?? 0.1;
}

const dist = (a, b) => {
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  return Math.abs(ax - bx) + Math.abs(ay - by);
};

// Chances of each rank for the enemy piece on `sq`. Pieces that have moved
// can't be bombs or the flag, so those belong to the pieces that haven't.
function odds(piece, k, sq) {
  const seen = k.known.get(piece.id);
  if (seen) return { [seen]: 1 };
  const out = {};
  let pFlag = 0;
  let pBomb = 0;
  if (!piece.moved && k.unmoved) {
    pFlag = k.pool.flag && k.flagWeights ? Math.min(1, (k.pool.flag * flagWeight(k.enemy, sq)) / k.flagWeights) : 0;
    pBomb = Math.min(1 - pFlag, k.pool.bomb / k.unmoved);
  }
  const movableTotal = RANK_KEYS.reduce((n, r) => n + (RANKS[r].immobile ? 0 : k.pool[r]), 0);
  const pMovable = 1 - pFlag - pBomb;
  for (const r of RANK_KEYS) {
    if (r === 'flag') out[r] = pFlag;
    else if (r === 'bomb') out[r] = pBomb;
    else out[r] = movableTotal ? (pMovable * k.pool[r]) / movableTotal : 0;
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
    for (const [r, p] of Object.entries(odds(e, k, n))) {
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
    const o = odds(target, k, to);
    let ev = 0;
    let pWin = 0;
    for (const [r, p] of Object.entries(o)) {
      if (!p) continue;
      ev += p * outcomeValue(rank, r);
      if (fight(rank, r) === 'attacker') pWin += p;
    }
    score += ev;
    // Taking (or trading off) their last piece that can move wins the game.
    const seenRank = k.known.get(target.id);
    if (k.enemyMovable <= 1 && (target.moved || (seenRank && !RANKS[seenRank].immobile))) {
      const pBoth = Object.entries(o).reduce((n, [r, p]) => n + (fight(rank, r) === 'both' ? p : 0), 0);
      score += 30 * pWin + (k.myMovable > 1 ? 30 * pBoth : 0);
    }
    // Leave pieces that haven't moved (likely bombs) to the miners.
    // (less fussy the longer the game drags on).
    if (k.myMiners && rank !== 'miner' && VALUE[rank] >= 4) score -= (o.bomb || 0) * VALUE[rank] * (1 - boldness * 0.6);
    // Cheap pieces are worth spending to find out what something is.
    if (!k.known.has(target.id) && VALUE[rank] <= 1.6) score += 0.5;
    // Late on, send the cheapest pieces in (whatever they are by then).
    const expendable = VALUE[rank] <= Math.max(3, k.cheapest);
    if (!k.known.has(target.id) && expendable) {
      score += boldness * (k.myMiners ? Math.max(0, 1 - (o.bomb || 0) * 2.5) : 2.5);
    }
    score -= pWin * danger(view, side, k, rank, to, to) * 0.6;
    // Deal with anything that gets near our flag.
    if (k.myFlag != null) {
      const d = dist(to, k.myFlag);
      if (d <= 1) score += 6 * pWin;
      else if (d <= 2) score += 2 * pWin;
    }
    // Don't give away where the Marshal and General are for nothing.
    if (!piece.seen && VALUE[rank] >= 8 && !k.known.has(target.id)) score -= 0.12 * VALUE[rank];
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
  // Miners (or, with none left, the cheapest pieces) go after the likely flag.
  if (k.flagKnown && VALUE[rank] <= 6) {
    // It knows where the flag is: march there by the shortest real route.
    const before = routeLength(view, side, k, rank, from, k.flagGuess);
    const after = routeLength(view, side, k, rank, to, k.flagGuess);
    if (before < Infinity) score += (before - Math.min(after, before + 2)) * 1.2;
  } else {
    const flagHunter = k.myMiners ? rank === 'miner' : VALUE[rank] <= k.cheapest;
    if (flagHunter && k.flagGuess != null) score += (dist(from, k.flagGuess) - dist(to, k.flagGuess)) * (0.2 + boldness * 0.3);
  }
  // The Spy goes looking for a Marshal it knows about.
  if (rank === 'spy' && k.enemyMarshal != null) score += (dist(from, k.enemyMarshal) - dist(to, k.enemyMarshal)) * 0.4;
  // Strong pieces come back to guard the flag when enemies close in.
  if (k.myFlag != null && VALUE[rank] >= 3) {
    const intruder = nearestEnemyTo(view, side, k.myFlag);
    if (intruder != null && dist(intruder, k.myFlag) <= 3) score += (dist(from, intruder) - dist(to, intruder)) * 0.3;
  }
  // Near the end, hunt down their last moving pieces while we outnumber them.
  if (k.enemyMovable <= 3 && k.myMovable > k.enemyMovable && VALUE[rank] >= 3) {
    const prey = nearestEnemyTo(view, side, to);
    if (prey != null) score += (dist(from, prey) - dist(to, prey)) * 0.25;
  }
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

// How many steps `rank` needs to get from `start` to `goal`, going around
// lakes and through only what it can beat. Unknown pieces and our own
// (which can step aside) cost extra; a bomb blocks all but a miner.
function routeLength(view, side, k, rank, start, goal) {
  const cost = new Map([[start, 0]]);
  const queue = [[0, start]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [c, sq] = queue.shift();
    if (sq === goal) return c;
    if (c > cost.get(sq)) continue;
    const [x, y] = xy(sq);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx > 9 || ny > 9) continue;
      const n = ny * 10 + nx;
      if (isLake(n)) continue;
      const p = view.board[n];
      let step = 1;
      if (p && n !== goal) {
        if (p.side === side) step = 3;
        else {
          const r = k.known.get(p.id);
          if (!r) step = 3;
          else if (fight(rank, r) === 'attacker') step = 2;
          else continue;
        }
      }
      const next = c + step;
      if (next < (cost.get(n) ?? Infinity)) {
        cost.set(n, next);
        queue.push([next, n]);
      }
    }
  }
  return Infinity;
}

// The square of the enemy piece closest to `sq`.
function nearestEnemyTo(view, side, sq) {
  let best = null;
  view.board.forEach((p, i) => {
    if (p && p.side !== side && (p.moved || p.rank) && (best == null || dist(i, sq) < dist(best, sq))) best = i;
  });
  return best;
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

// Levels 101–120 play like 100 but also get to look at a share of the
// opponent's hidden pieces: half at 101, rising to all of them at 120.
export const MAX_LEVEL = 120;
export function peekShare(level) {
  if (level <= 100) return 0;
  return 0.5 + (0.5 * (Math.min(MAX_LEVEL, level) - 101)) / (MAX_LEVEL - 101);
}

// The hidden enemy pieces a level-101+ robot gets to see: always the same
// ones for a given piece and game. `board` is the real board, not a view.
export function peekAt(board, enemy, level, seed) {
  const share = peekShare(level);
  const out = new Map();
  if (!share) return out;
  for (const p of board) if (p && p.side === enemy && stableRandom(seed + 1, p.id) < share) out.set(p.id, p.rank);
  return out;
}

// Picks the robot's move from its own view of the game, or null if it has none.
// level runs from 1 (easiest) to 120 (hardest). Lower levels forget pieces
// they've seen, judge moves more loosely and now and then just play anything.
// `peek` is what peekAt() lets a level above 100 see.
export function chooseMove(view, side, rng = Math.random, { level = 100, seed = 0, peek = null } = {}) {
  const skill = (Math.min(100, Math.max(1, level)) - 1) / 99;
  const memory = 0.55 + 0.45 * skill;
  const k = knowledge(view, side, (id) => stableRandom(seed, id) < memory, peek);
  const moves = [];
  view.board.forEach((p, from) => {
    if (p && p.side === side) for (const to of legalTargets(view, from)) moves.push({ from, to });
  });
  if (!moves.length) return null;
  if (rng() < (1 - skill) ** 2 * 0.2) return moves[Math.floor(rng() * moves.length)];
  const noise = 0.03 + (1 - skill) ** 1.5 * 1.6;
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
  if (event.reason === 'draw') return 'A draw! Neither of us can move. Good game.';
  if (event.winner) return pick(event.winner === side ? LINES.gameWon : LINES.gameLost);
  if (event.kind !== 'attack' || event.result === 'both' || rng() > 0.35) return null;
  const robotWon = (event.result === 'attacker' ? event.attacker : event.defender).side === side;
  return pick(robotWon ? LINES.won : LINES.lost);
}
