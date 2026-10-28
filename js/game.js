// Stratego rules engine. Pure data + functions, no DOM, so the host browser
// can referee the match and Node can run the tests.

export const SIZE = 10;
export const SIDES = ['red', 'blue'];
export const other = (side) => (side === 'red' ? 'blue' : 'red');

// Ordered strongest → weakest, then the immobile pieces.
export const RANKS = {
  marshal:    { name: 'Marshal',    label: '10', strength: 10, count: 1 },
  general:    { name: 'General',    label: '9',  strength: 9,  count: 1 },
  colonel:    { name: 'Colonel',    label: '8',  strength: 8,  count: 2 },
  major:      { name: 'Major',      label: '7',  strength: 7,  count: 3 },
  captain:    { name: 'Captain',    label: '6',  strength: 6,  count: 4 },
  lieutenant: { name: 'Lieutenant', label: '5',  strength: 5,  count: 4 },
  sergeant:   { name: 'Sergeant',   label: '4',  strength: 4,  count: 4 },
  miner:      { name: 'Miner',      label: '3',  strength: 3,  count: 5 },
  scout:      { name: 'Scout',      label: '2',  strength: 2,  count: 8 },
  spy:        { name: 'Spy',        label: 'S',  strength: 1,  count: 1 },
  bomb:       { name: 'Bomb',       label: 'B',  strength: 0,  count: 6, immobile: true },
  flag:       { name: 'Flag',       label: 'F',  strength: 0,  count: 1, immobile: true },
};
export const RANK_KEYS = Object.keys(RANKS);
export const ARMY_SIZE = RANK_KEYS.reduce((n, k) => n + RANKS[k].count, 0); // 40

export const idx = (x, y) => y * SIZE + x;
export const xy = (i) => [i % SIZE, Math.floor(i / SIZE)];
const inBounds = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;

const LAKES = new Set([
  idx(2, 4), idx(3, 4), idx(2, 5), idx(3, 5),
  idx(6, 4), idx(7, 4), idx(6, 5), idx(7, 5),
]);
export const isLake = (i) => LAKES.has(i);

// Board coordinates as players read them: columns A–J, rows 1–10 from Red's side.
export function squareName(i) {
  const [x, y] = xy(i);
  return 'ABCDEFGHIJ'[x] + (SIZE - y);
}

// Red deploys on rows 6–9 (south), Blue on rows 0–3 (north).
const HOME_ROWS = { red: [6, 7, 8, 9], blue: [0, 1, 2, 3] };
const BACK_ROW = { red: 9, blue: 0 };
const FORWARD = { red: -1, blue: 1 };

export function homeSquares(side) {
  const out = [];
  for (const y of HOME_ROWS[side]) for (let x = 0; x < SIZE; x++) out.push(idx(x, y));
  return out;
}

export function isValidArmy(ranks) {
  if (!Array.isArray(ranks) || ranks.length !== ARMY_SIZE) return false;
  const counts = {};
  for (const r of ranks) {
    if (!RANKS[r]) return false;
    counts[r] = (counts[r] || 0) + 1;
  }
  return RANK_KEYS.every((k) => counts[k] === RANKS[k].count);
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// A random but sensible deployment: flag on the back row with a couple of
// bombs guarding it, everything else shuffled. Returned in homeSquares() order.
export function randomArmy(side, rng = Math.random) {
  const squares = homeSquares(side);
  const placed = new Map();
  const back = BACK_ROW[side];
  const flagSq = idx(Math.floor(rng() * SIZE), back);
  placed.set(flagSq, 'flag');

  const [fx, fy] = xy(flagSq);
  const guards = shuffle(
    [[fx - 1, fy], [fx + 1, fy], [fx, fy + FORWARD[side]]]
      .filter(([x, y]) => inBounds(x, y))
      .map(([x, y]) => idx(x, y)),
    rng,
  );
  const guardCount = Math.min(guards.length, 2 + (rng() < 0.5 ? 1 : 0));
  for (const sq of guards.slice(0, guardCount)) placed.set(sq, 'bomb');

  const pool = [];
  for (const k of RANK_KEYS) {
    let n = RANKS[k].count;
    if (k === 'flag') n -= 1;
    if (k === 'bomb') n -= guardCount;
    for (let i = 0; i < n; i++) pool.push(k);
  }
  shuffle(pool, rng);
  return squares.map((sq) => placed.get(sq) || pool.pop());
}

export function newGame() {
  return {
    phase: 'setup', // setup → play → over
    board: Array(SIZE * SIZE).fill(null),
    ready: { red: false, blue: false },
    turn: 'red',
    moveCount: 0,
    nextId: 1,
    lastMove: null,
    recent: { red: [], blue: [] }, // last few moves per side, for the two-square rule
    lost: { red: [], blue: [] },   // ranks each side has lost
    log: [],
    winner: null,
    reason: null,
  };
}

const fail = (error) => ({ ok: false, error });

export function deploy(state, side, ranks) {
  if (state.phase !== 'setup') return fail('Deployment is over.');
  if (state.ready[side]) return fail('Your army is already deployed.');
  if (!isValidArmy(ranks)) return fail('That army is not a valid Stratego army.');
  homeSquares(side).forEach((sq, i) => {
    state.board[sq] = { id: state.nextId++, side, rank: ranks[i], seen: false, moved: false };
  });
  state.ready[side] = true;
  if (state.ready.red && state.ready.blue) {
    state.phase = 'play';
    state.turn = 'red';
    addLog(state, { kind: 'start' });
  }
  return { ok: true };
}

// Outcome of an attack: 'attacker', 'defender' or 'both' (equal ranks).
export function fight(attacker, defender) {
  if (defender === 'flag') return 'attacker';
  if (defender === 'bomb') return attacker === 'miner' ? 'attacker' : 'defender';
  if (attacker === 'spy' && defender === 'marshal') return 'attacker';
  const a = RANKS[attacker].strength;
  const d = RANKS[defender].strength;
  return a > d ? 'attacker' : a < d ? 'defender' : 'both';
}

const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// A piece may not shuttle between the same two squares on more than three
// consecutive turns.
function breaksTwoSquareRule(state, piece, from, to) {
  const recent = state.recent[piece.side];
  if (recent.length < 3) return false;
  const key = pairKey(from, to);
  return recent.slice(-3).every((m) => m.id === piece.id && pairKey(m.from, m.to) === key);
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Squares the piece on `from` may move to or attack. Works on a player's
// filtered view too, since only the moving piece's rank is needed.
export function legalTargets(state, from) {
  const piece = state.board[from];
  if (!piece || !piece.rank || RANKS[piece.rank].immobile) return [];
  const [x, y] = xy(from);
  const out = [];
  for (const [dx, dy] of DIRS) {
    let cx = x + dx;
    let cy = y + dy;
    while (inBounds(cx, cy)) {
      const t = idx(cx, cy);
      if (isLake(t)) break;
      const occupant = state.board[t];
      if (occupant) {
        if (occupant.side !== piece.side) out.push(t);
        break;
      }
      out.push(t);
      if (piece.rank !== 'scout') break;
      cx += dx;
      cy += dy;
    }
  }
  return out.filter((t) => !breaksTwoSquareRule(state, piece, from, t));
}

export function hasLegalMove(state, side) {
  return state.board.some((p, i) => p && p.side === side && legalTargets(state, i).length > 0);
}

function addLog(state, entry) {
  state.log.push({ n: state.moveCount, ...entry });
  if (state.log.length > 60) state.log.splice(0, state.log.length - 60);
}

function finish(state, winner, reason) {
  state.phase = 'over';
  state.winner = winner;
  state.reason = reason;
  addLog(state, { kind: 'over', winner, reason });
}

// Applies a move for `side`. Returns { ok, event } where event describes what
// happened publicly. Ranks only appear in a battle, and only for that moment:
// afterwards the survivor is face-down again, as in the board game, so players
// have to remember what they saw. `seen` records that the enemy has seen it.
export function move(state, side, from, to) {
  if (state.phase !== 'play') return fail('The game is not in progress.');
  if (state.turn !== side) return fail("It's not your turn.");
  const piece = state.board[from];
  if (!piece || piece.side !== side) return fail('Pick one of your own pieces.');
  if (!legalTargets(state, from).includes(to)) return fail("That piece can't move there.");

  const target = state.board[to];
  const [fx, fy] = xy(from);
  const [tx, ty] = xy(to);
  const distance = Math.abs(fx - tx) + Math.abs(fy - ty);
  piece.moved = true;

  let event;
  state.board[from] = null;
  if (!target) {
    state.board[to] = piece;
    // Only a scout can run several squares, so the log may say so.
    event = { kind: 'move', side, from, to, id: piece.id, rank: distance > 1 ? piece.rank : undefined };
  } else {
    const result = fight(piece.rank, target.rank);
    event = {
      kind: 'attack', side, from, to, id: piece.id, result,
      attacker: { id: piece.id, rank: piece.rank, side },
      defender: { id: target.id, rank: target.rank, side: target.side },
    };
    if (result === 'attacker') {
      state.board[to] = piece;
      piece.seen = true;
      state.lost[target.side].push(target.rank);
    } else if (result === 'defender') {
      target.seen = true;
      state.lost[side].push(piece.rank);
    } else {
      state.board[to] = null;
      state.lost[side].push(piece.rank);
      state.lost[target.side].push(target.rank);
    }
  }

  state.recent[side].push({ id: piece.id, from, to });
  if (state.recent[side].length > 3) state.recent[side].shift();
  state.moveCount++;
  state.lastMove = { side, from, to };
  state.turn = other(side);
  addLog(state, { ...event });

  // A player who can't move on their turn loses.
  if (target && target.rank === 'flag') finish(state, side, 'flag');
  else if (!hasLegalMove(state, state.turn)) finish(state, side, 'stuck');
  if (state.phase === 'over') event.winner = state.winner;
  return { ok: true, event };
}

export function resign(state, side) {
  if (state.phase === 'over') return fail('The game is already over.');
  finish(state, other(side), 'resign');
  return { ok: true, event: { kind: 'resign', side, winner: state.winner } };
}

// What `side` is allowed to know: enemy ranks stay hidden (even pieces that
// have fought), and everything is shown once the game ends.
export function viewFor(state, side) {
  const showAll = state.phase === 'over';
  return {
    ...state,
    board: state.board.map((p) => {
      if (!p) return null;
      if (p.side === side || showAll) return { ...p };
      return { id: p.id, side: p.side, rank: null, moved: p.moved };
    }),
    ready: { ...state.ready },
    recent: { red: state.recent.red.map((m) => ({ ...m })), blue: state.recent.blue.map((m) => ({ ...m })) },
    lost: { red: [...state.lost.red], blue: [...state.lost.blue] },
    log: state.log.map((e) => ({ ...e })),
  };
}

// How many of each rank `side` still has on the board.
export function remaining(state, side) {
  const out = {};
  for (const k of RANK_KEYS) out[k] = RANKS[k].count;
  for (const r of state.lost[side]) out[r]--;
  return out;
}
