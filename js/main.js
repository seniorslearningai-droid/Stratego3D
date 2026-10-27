// Wires everything together: lobby, the host's referee, the guest link,
// the HUD and the 3D board.

import {
  RANKS, RANK_KEYS, deploy, homeSquares, isValidArmy, legalTargets, move, newGame, other,
  randomArmy, remaining, resign, squareName, viewFor,
} from './game.js';
import { GuestLink, HostLink, isCode, makeCode, makeToken, normalizeCode } from './net.js';
import { BoardScene } from './scene.js';
import { isMuted, setMuted, sfx } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const SIDE_NAME = { red: 'Red', blue: 'Blue' };
const TITLE = 'Stratego 3D';

// ---------------------------------------------------------------- storage

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* storage blocked */ }
  },
};

// Which role this browser tab plays in a game. Kept per tab so a reload
// resumes the same role, while a second tab can join as the opponent.
const tabRole = {
  get(code) { try { return sessionStorage.getItem(`stratego3d:role:${code}`); } catch { return null; } },
  set(code, role) { try { sessionStorage.setItem(`stratego3d:role:${code}`, role); } catch { /* blocked */ } },
  clear(code) { try { sessionStorage.removeItem(`stratego3d:role:${code}`); } catch { /* blocked */ } },
};

const KEYS = {
  name: 'stratego3d:name',
  host: (code) => `stratego3d:host:${code}`,
  guest: (code) => `stratego3d:guest:${code}`,
  draft: (code, side) => `stratego3d:draft:${code}:${side}`,
};

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 20);

// ---------------------------------------------------------------- app state

const app = {
  role: null,       // 'host' | 'guest'
  code: null,
  mySide: null,
  myName: '',
  inGame: false,
  net: 'connecting',
  view: null,       // the game as this player is allowed to see it
  meta: {},
  draft: null,      // [{ id, rank }] in homeSquares() order while arranging the army
  swapFrom: null,
  selected: null,
  hover: null,
  pending: false,   // a move is on its way to the host
  chat: [],
  unread: 0,
  showInvite: false,
  link: null,
  referee: null,
};
let scene;

const opp = () => other(app.mySide);
const oppName = () => (app.role === 'host' ? app.meta.guestName : app.meta.hostName) || SIDE_NAME[opp()];
const oppOnline = () => (app.role === 'host' ? !!app.meta.guestOnline : app.net === 'online');

// ---------------------------------------------------------------- the referee (host only)

// The host's browser holds the real game and checks every move against the
// rules. Each player is only ever sent their own view of it.
class Referee {
  constructor(record) {
    this.r = record;
    this.guestConn = null;
  }

  get hostSide() { return this.r.hostSide; }
  get guestSide() { return other(this.r.hostSide); }

  save() { store.set(KEYS.host(this.r.code), this.r); }

  meta() {
    return {
      hostName: this.r.hostName,
      guestName: this.r.guestName,
      rematch: { ...this.r.rematch },
      guestOnline: !!this.guestConn,
    };
  }

  act(side, action) {
    const s = this.r.state;
    let res;
    if (action.t === 'deploy') res = deploy(s, side, action.ranks);
    else if (action.t === 'move') res = move(s, side, action.from, action.to);
    else if (action.t === 'resign') res = resign(s, side);
    else if (action.t === 'rematch') res = this.rematch(side);
    else return { ok: false, error: 'Unknown action.' };
    if (res.ok) {
      this.save();
      this.broadcast(res.event || null);
    }
    return res;
  }

  rematch(side) {
    if (this.r.state.phase !== 'over') return { ok: false, error: 'The game is still going.' };
    this.r.rematch[side] = true;
    if (this.r.rematch.red && this.r.rematch.blue) {
      this.r.state = newGame();
      this.r.rematch = {};
      return { ok: true, event: { kind: 'rematch' } };
    }
    return { ok: true };
  }

  broadcast(event = null) {
    const meta = this.meta();
    receive(viewFor(this.r.state, this.hostSide), event, meta);
    if (this.guestConn) {
      app.link.send(this.guestConn, { t: 'state', view: viewFor(this.r.state, this.guestSide), event, meta });
    }
  }

  addChat(side, text) {
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return;
    const msg = { side, name: side === this.hostSide ? this.r.hostName : this.r.guestName, text: clean, at: Date.now() };
    this.r.chat.push(msg);
    if (this.r.chat.length > 60) this.r.chat.splice(0, this.r.chat.length - 60);
    this.save();
    receiveChat(msg);
    if (this.guestConn) app.link.send(this.guestConn, { t: 'chat', msg });
  }
}

function onHostMessage(msg, conn) {
  const ref = app.referee;
  if (msg.t === 'hello') {
    const name = cleanName(msg.name) || 'Opponent';
    if (ref.r.guestToken && ref.r.guestToken !== msg.token) {
      app.link.send(conn, { t: 'full' });
      setTimeout(() => conn.close(), 800);
      return;
    }
    const firstTime = !ref.r.guestToken;
    ref.r.guestToken = msg.token;
    ref.r.guestName = name;
    ref.save();
    ref.guestConn = conn;
    app.link.closeOthers(conn);
    app.link.send(conn, { t: 'welcome', side: ref.guestSide, hostName: ref.r.hostName, chat: ref.r.chat });
    app.showInvite = false;
    ref.broadcast(null);
    sfx.join();
    toast(firstTime ? `${name} joined as ${SIDE_NAME[ref.guestSide]}!` : `${name} is back.`, 'good');
    return;
  }
  if (conn !== ref.guestConn) return;
  if (msg.t === 'chat') {
    ref.addChat(ref.guestSide, msg.text);
  } else if (['deploy', 'move', 'resign', 'rematch'].includes(msg.t)) {
    const res = ref.act(ref.guestSide, msg);
    if (!res.ok) app.link.send(conn, { t: 'error', error: res.error });
  }
}

function onGuestLeft(conn) {
  const ref = app.referee;
  if (conn !== ref.guestConn) return;
  ref.guestConn = null;
  if (ref.r.state.phase !== 'over') {
    toast(`${ref.r.guestName || 'Your opponent'} lost connection. They can rejoin with the same link.`, 'warn', 5000);
  }
  ref.broadcast(null);
}

// ---------------------------------------------------------------- guest

function onGuestMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      app.mySide = msg.side;
      app.meta = { hostName: msg.hostName };
      app.chat = msg.chat || [];
      tabRole.set(app.code, 'guest');
      if (!app.inGame) {
        enterGame();
        toast(`You're playing ${SIDE_NAME[msg.side]} against ${msg.hostName}.`, 'good');
      }
      renderChat();
      break;
    case 'state':
      if (app.mySide) receive(msg.view, msg.event, msg.meta);
      break;
    case 'chat':
      receiveChat(msg.msg);
      break;
    case 'error':
      app.pending = false;
      toast(msg.error, 'warn');
      sfx.error();
      render();
      break;
    case 'full':
      app.link.destroy();
      tabRole.clear(app.code);
      store.remove(KEYS.guest(app.code));
      showView('create');
      showLobbyError('That game already has two players. Ask for a new link, or start your own game.');
      break;
    default:
  }
}

// ---------------------------------------------------------------- sending actions

function sendAction(action) {
  if (app.role === 'host') {
    const res = app.referee.act(app.mySide, action);
    if (!res.ok) {
      app.pending = false;
      toast(res.error, 'warn');
      sfx.error();
      render();
    }
    return;
  }
  if (!app.link.send(action)) {
    app.pending = false;
    toast('Not connected to the other player right now. Reconnecting…', 'warn');
    render();
  }
}

function sendChat(text) {
  const clean = text.trim();
  if (!clean) return;
  if (app.role === 'host') app.referee.addChat(app.mySide, clean);
  else if (!app.link.send({ t: 'chat', text: clean })) toast('Not connected right now — message not sent.', 'warn');
}

// ---------------------------------------------------------------- receiving the game

function receive(view, event, meta) {
  const prev = app.view;
  app.view = view;
  app.meta = meta || {};
  app.pending = false;

  const deploying = view.phase === 'setup' && !view.ready[app.mySide];
  if (deploying && !app.draft) app.draft = loadDraft();
  if (!deploying && app.draft) {
    app.draft = null;
    app.swapFrom = null;
    store.remove(KEYS.draft(app.code, app.mySide));
  }
  if (app.selected != null && !canSelect(app.selected)) app.selected = null;

  const duration = scene.sync(displayCells(), event);
  react(prev, view, event, duration);
  render();
}

function react(prev, view, event, duration) {
  if (event?.kind === 'move') sfx.move();
  if (event?.kind === 'attack') {
    sfx.move();
    sfx.clash(0.3);
    setTimeout(() => showCombat(event), 250);
  }
  if (event?.kind === 'rematch') {
    $('#overModal').hidden = true;
    toast('New game! Set up your army.', 'good');
  }
  if (prev?.phase === 'setup' && view.phase === 'setup' && !prev.ready[opp()] && view.ready[opp()]) {
    toast(`${oppName()} has deployed their army.`);
  }
  if (prev?.phase === 'setup' && view.phase === 'play') {
    toast(view.turn === app.mySide ? 'All set — you move first!' : `All set — ${oppName()} moves first.`, 'good');
  }
  const myTurnNow = view.phase === 'play' && view.turn === app.mySide;
  const myTurnBefore = prev?.phase === 'play' && prev.turn === app.mySide;
  if (myTurnNow && !myTurnBefore) {
    setTimeout(() => sfx.turn(), duration);
    if (document.hidden) document.title = `● Your move — ${TITLE}`;
  }
  if (view.phase === 'over' && prev?.phase !== 'over') {
    setTimeout(() => {
      if (app.view.phase !== 'over') return;
      showGameOver();
      (app.view.winner === app.mySide ? sfx.win : sfx.lose)();
    }, prev ? duration + 500 : 0);
  }
}

function displayCells() {
  const cells = app.view.board.slice();
  if (app.draft) {
    homeSquares(app.mySide).forEach((sq, i) => {
      cells[sq] = { id: app.draft[i].id, side: app.mySide, rank: app.draft[i].rank, revealed: false };
    });
  }
  return cells;
}

// ---------------------------------------------------------------- deployment

function loadDraft() {
  const saved = store.get(KEYS.draft(app.code, app.mySide));
  const ranks = isValidArmy(saved) ? saved : randomArmy(app.mySide);
  return ranks.map((rank, i) => ({ id: `d${i}`, rank }));
}

function saveDraft() {
  store.set(KEYS.draft(app.code, app.mySide), app.draft.map((d) => d.rank));
}

function shuffleDraft() {
  if (!app.draft) return;
  // Reuse the same pieces so they visibly hop to their new squares.
  const pool = {};
  for (const d of app.draft) (pool[d.rank] ||= []).push(d);
  app.draft = randomArmy(app.mySide).map((rank) => pool[rank].pop());
  app.swapFrom = null;
  saveDraft();
  scene.sync(displayCells());
  sfx.swap();
  render();
}

function clickDuringSetup(sq) {
  const squares = homeSquares(app.mySide);
  const slot = squares.indexOf(sq);
  if (slot < 0) {
    app.swapFrom = null;
  } else if (app.swapFrom == null) {
    app.swapFrom = sq;
    sfx.select();
  } else if (app.swapFrom === sq) {
    app.swapFrom = null;
  } else {
    const a = squares.indexOf(app.swapFrom);
    [app.draft[a], app.draft[slot]] = [app.draft[slot], app.draft[a]];
    app.swapFrom = null;
    saveDraft();
    scene.sync(displayCells());
    sfx.swap();
  }
  render();
}

// ---------------------------------------------------------------- playing

function canSelect(sq) {
  const v = app.view;
  const p = v?.board[sq];
  return !!(v && v.phase === 'play' && v.turn === app.mySide && p && p.side === app.mySide && legalTargets(v, sq).length);
}

const targetsOf = (sq) => legalTargets(app.view, sq);

let lastNudge = 0;
function nudge(text) {
  if (Date.now() - lastNudge < 1500) return;
  lastNudge = Date.now();
  toast(text, '', 2200);
}

// Of the squares under the pointer, the one the player most likely means:
// a highlighted destination beats the piece standing in front of it.
function chooseSquare(squares) {
  if (app.selected != null) {
    const targets = targetsOf(app.selected);
    const hit = squares.find((sq) => targets.includes(sq));
    if (hit != null) return hit;
  }
  return squares.find((sq) => isInteractive(sq)) ?? squares[0];
}

function onSquareClick(squares) {
  document.body.classList.remove('panel-open');
  const v = app.view;
  if (!v || !app.inGame) return;
  const sq = chooseSquare(squares);
  if (app.draft) return clickDuringSetup(sq);
  if (v.phase !== 'play') return;
  if (v.turn !== app.mySide) return nudge(`It's ${oppName()}'s turn — hang on.`);
  if (app.pending) return;

  if (app.selected != null && targetsOf(app.selected).includes(sq)) {
    const from = app.selected;
    app.selected = null;
    app.pending = true;
    render();
    sendAction({ t: 'move', from, to: sq });
    return;
  }

  const piece = v.board[sq];
  if (piece && piece.side === app.mySide) {
    if (app.selected === sq) app.selected = null;
    else if (RANKS[piece.rank].immobile) {
      app.selected = null;
      nudge(`Your ${RANKS[piece.rank].name} can't move.`);
    } else if (!targetsOf(sq).length) {
      app.selected = null;
      nudge('That piece is boxed in right now.');
    } else {
      app.selected = sq;
      sfx.select();
    }
  } else {
    app.selected = null;
  }
  render();
}

function isInteractive(sq) {
  const v = app.view;
  if (!v || sq == null) return false;
  if (app.draft) return homeSquares(app.mySide).includes(sq);
  if (v.phase !== 'play' || v.turn !== app.mySide || app.pending) return false;
  if (app.selected != null && targetsOf(app.selected).includes(sq)) return true;
  return canSelect(sq);
}

function onHover(squares) {
  if (!app.inGame) return;
  const sq = chooseSquare(squares);
  const next = isInteractive(sq) ? sq : null;
  $('#board').style.cursor = next != null ? 'pointer' : '';
  if (next === app.hover) return;
  app.hover = next;
  renderMarks();
}

// ---------------------------------------------------------------- rendering the HUD

const BOMB_SVG = '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="14" r="7"/><rect x="14" y="5" width="4.5" height="4.5" transform="rotate(45 16.2 7.2)"/><path d="M17.5 5.2q2-3.4 4.4-2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
const FLAG_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="2.5" width="2.2" height="19" rx="1"/><path d="M7.2 3.5c4.5-2 6.5 2 12.3 0v9.5c-5.8 2-7.8-2-12.3 0z"/></svg>';

function miniPiece(side, rank) {
  if (!rank) return `<span class="mini-piece ${side} hidden-rank"></span>`;
  const inner = rank === 'bomb' ? BOMB_SVG : rank === 'flag' ? FLAG_SVG : `<b>${RANKS[rank].label}</b>`;
  return `<span class="mini-piece ${side}" title="${RANKS[rank].name}">${inner}</span>`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render() {
  if (!app.view || !app.inGame) return;
  renderBanner();
  renderPlayers();
  renderChips();
  renderLog();
  renderBottomBar();
  renderInvite();
  renderMarks();
  renderOverModal();
  $('#resignBtn').disabled = app.view.phase !== 'play';
  $('#inviteAgainBtn').hidden = app.role !== 'host';
  updateInsets();
}

function renderBanner() {
  const v = app.view;
  const el = $('#turnBanner');
  let text;
  let cls = '';
  if (app.role === 'guest' && app.net !== 'online') {
    text = 'Reconnecting…';
  } else if (v.phase === 'setup') {
    if (app.draft) text = 'Deploy your army';
    else if (app.role === 'host' && !app.meta.guestName) text = 'Waiting for an opponent';
    else text = `Waiting for ${oppName()}…`;
  } else if (v.phase === 'play') {
    if (v.turn === app.mySide) {
      text = app.pending ? 'Moving…' : 'Your move';
      cls = 'mine';
    } else {
      text = `${oppName()}'s move`;
      cls = 'theirs';
    }
  } else {
    const won = v.winner === app.mySide;
    text = won ? 'Victory!' : 'Defeat';
    cls = won ? 'win' : 'lose';
  }
  el.textContent = text;
  el.className = `turn-banner ${cls}`;
}

function playerCard(side, name, statusText, dot) {
  const v = app.view;
  const active = v.phase === 'play' && v.turn === side;
  const mine = side === app.mySide;
  return {
    cls: `player ${side}${active ? ' active' : ''}`,
    html: `<div class="who">${mine ? 'You' : 'Opponent'} · ${SIDE_NAME[side]}</div>
      <div class="pname">${escapeHtml(name)}</div>
      <div class="pstatus"><span class="dot ${dot}"></span>${statusText}</div>`,
  };
}

function renderPlayers() {
  const v = app.view;
  const me = app.mySide;
  const them = opp();
  let myStatus = 'Ready';
  if (v.phase === 'setup') myStatus = app.draft ? 'Deploying…' : 'Ready';
  else if (v.phase === 'play') myStatus = v.turn === me ? 'Your move' : 'Waiting';
  else myStatus = v.winner === me ? 'Winner' : 'Defeated';

  const joined = app.role === 'guest' || !!app.meta.guestName;
  let theirStatus;
  let dot = 'on';
  if (!joined) {
    theirStatus = 'Not joined yet';
    dot = 'wait';
  } else if (!oppOnline()) {
    theirStatus = 'Offline';
    dot = '';
  } else if (v.phase === 'setup') {
    theirStatus = v.ready[them] ? 'Ready' : 'Deploying…';
  } else if (v.phase === 'play') {
    theirStatus = v.turn === them ? 'Thinking…' : 'Waiting';
  } else {
    theirStatus = v.winner === them ? 'Winner' : 'Defeated';
  }

  const a = playerCard(me, app.myName, myStatus, 'on');
  const b = playerCard(them, joined ? oppName() : 'Waiting…', theirStatus, dot);
  $('#mePlayer').className = a.cls;
  $('#mePlayer').innerHTML = a.html;
  $('#oppPlayer').className = b.cls;
  $('#oppPlayer').innerHTML = b.html;
}

function renderChips() {
  const v = app.view;
  for (const [el, side] of [[$('#enemyChips'), opp()], [$('#myChips'), app.mySide]]) {
    const left = remaining(v, side);
    el.innerHTML = RANK_KEYS.map((k) => `<div class="chip${left[k] ? '' : ' zero'}" title="${RANKS[k].name}">
      ${miniPiece(side, k)}<span>×${left[k]}</span></div>`).join('');
  }
}

function sideTag(side) {
  return `<span class="${side === 'red' ? 'r' : 'b'}">${SIDE_NAME[side]}</span>`;
}

function reasonLine(winner, reason) {
  if (reason === 'flag') return `${sideTag(winner)} captured the flag and wins!`;
  if (reason === 'stuck') return `${sideTag(other(winner))} has no pieces that can move. ${sideTag(winner)} wins!`;
  return `${sideTag(other(winner))} resigned. ${sideTag(winner)} wins.`;
}

function logLine(e) {
  const sq = (i) => `<span class="sq">${squareName(i)}</span>`;
  switch (e.kind) {
    case 'start': return 'The battle begins. Red moves first.';
    case 'move': return `${sideTag(e.side)} ${e.rank ? 'Scout ran' : 'moved'} ${sq(e.from)} → ${sq(e.to)}`;
    case 'attack': {
      const a = `${sideTag(e.attacker.side)} ${RANKS[e.attacker.rank].name}`;
      const d = `${sideTag(e.defender.side)} ${RANKS[e.defender.rank].name}`;
      const res = e.result === 'attacker' ? 'and won' : e.result === 'defender' ? 'and lost' : '— both fell';
      return `${a} attacked ${d} at ${sq(e.to)} ${res}`;
    }
    case 'over': return reasonLine(e.winner, e.reason);
    default: return '';
  }
}

let lastLogKey = '';
function renderLog() {
  const log = app.view.log;
  const key = `${log.length}:${log.at(-1)?.n}:${log.at(-1)?.kind}`;
  if (key === lastLogKey) return;
  lastLogKey = key;
  const items = log.slice().reverse().map((e) => `<li>${logLine(e)}</li>`);
  $('#log').innerHTML = items.length ? items.join('') : '<li>No moves yet.</li>';
}

function renderBottomBar() {
  const v = app.view;
  const bar = $('#setupBar');
  const text = $('#setupText');
  const shuffle = $('#shuffleBtn');
  const ready = $('#readyBtn');
  bar.hidden = false;
  if (v.phase === 'setup' && app.draft) {
    if (app.swapFrom != null) {
      const slot = homeSquares(app.mySide).indexOf(app.swapFrom);
      text.innerHTML = `Now tap the piece to swap with your <b>${RANKS[app.draft[slot].rank].name}</b>.`;
    } else {
      text.innerHTML = 'Tap two of your pieces to <b>swap</b> them. Keep your flag safe!';
    }
    shuffle.hidden = false;
    ready.hidden = false;
    ready.textContent = "I'm ready";
    ready.disabled = app.role === 'guest' && app.net !== 'online';
  } else if (v.phase === 'setup') {
    text.innerHTML = app.role === 'host' && !app.meta.guestName
      ? 'Your army is in place. The battle starts when your opponent joins and deploys.'
      : `Your army is in place. Waiting for <b>${escapeHtml(oppName())}</b> to finish deploying…`;
    shuffle.hidden = true;
    ready.hidden = true;
  } else if (v.phase === 'over' && $('#overModal').hidden) {
    text.innerHTML = 'Game over — every piece is now revealed.';
    shuffle.hidden = true;
    ready.hidden = false;
    ready.disabled = !!app.meta.rematch?.[app.mySide];
    ready.textContent = app.meta.rematch?.[app.mySide] ? 'Waiting…' : 'Play again';
  } else {
    bar.hidden = true;
  }
}

function renderInvite() {
  const show = app.role === 'host' && (app.showInvite || !app.meta.guestName);
  $('#inviteCard').hidden = !show;
  if (show) {
    $('#hostCode').textContent = app.code;
    $('#shareLink').value = shareUrl();
    $('#shareBtn').hidden = !navigator.share;
  }
}

function renderMarks() {
  const v = app.view;
  if (!v || !app.inGame) return;
  const marks = { lastMove: v.phase === 'play' || v.phase === 'over' ? v.lastMove : null, hover: app.hover };
  if (app.draft) {
    marks.zone = homeSquares(app.mySide);
    marks.selected = app.swapFrom;
  } else if (app.selected != null) {
    marks.selected = app.selected;
    marks.targets = targetsOf(app.selected).map((sq) => ({ sq, attack: !!v.board[sq] }));
  }
  scene.setMarks(marks);
}

let insetKey = '';
function updateInsets() {
  const wide = window.innerWidth > 860;
  const bar = $('#setupBar');
  const top = wide ? 64 : 56;
  const right = wide ? 320 + 24 : 0;
  const bottom = bar.hidden ? 0 : bar.offsetHeight + (wide ? 24 : 16);
  const key = `${top}:${right}:${bottom}`;
  if (key === insetKey) return;
  insetKey = key;
  scene.setInsets({ top, right, bottom });
}

// ---------------------------------------------------------------- combat & game over

function showCombat(e) {
  const el = $('#combat');
  const lostA = e.result !== 'attacker';
  const lostD = e.result !== 'defender';
  const fighter = (f, lost, role) => `<div class="fighter${lost ? ' lost' : ''}">
      ${miniPiece(f.side, f.rank)}
      <span>${f.side === app.mySide ? 'Your' : `${SIDE_NAME[f.side]}'s`} ${RANKS[f.rank].name}</span>
      <small>${role}</small></div>`;
  let verdict;
  const winner = e.result === 'attacker' ? e.attacker : e.defender;
  if (e.defender.rank === 'flag') verdict = e.attacker.side === app.mySide ? 'You captured the flag!' : 'Your flag has been captured!';
  else if (e.defender.rank === 'bomb' && e.attacker.rank === 'miner') verdict = 'The Miner defuses the bomb!';
  else if (e.defender.rank === 'bomb') verdict = 'BOOM! The bomb wins.';
  else if (e.attacker.rank === 'spy' && e.defender.rank === 'marshal') verdict = 'The Spy takes down the Marshal!';
  else if (e.result === 'both') verdict = 'Equal ranks — both pieces fall.';
  else verdict = winner.side === app.mySide ? 'You win the battle!' : 'You lose this battle.';
  el.innerHTML = `<div class="duel">${fighter(e.attacker, lostA, 'attacks')}<div class="swords">VS</div>${fighter(e.defender, lostD, 'defends')}</div>
    <div class="verdict">${verdict}</div>`;
  el.classList.remove('leaving');
  el.hidden = false;
  clearTimeout(showCombat.timer);
  showCombat.timer = setTimeout(() => {
    el.classList.add('leaving');
    showCombat.timer = setTimeout(() => { el.hidden = true; }, 300);
  }, 2600);
}

function showGameOver() {
  $('#overModal').hidden = false;
  renderOverModal();
  render();
}

function renderOverModal() {
  const v = app.view;
  if ($('#overModal').hidden || v.phase !== 'over') return;
  const won = v.winner === app.mySide;
  $('.over-card').classList.toggle('win', won);
  $('#overEmblem').innerHTML = miniPiece(v.winner, 'flag');
  $('#overTitle').textContent = won ? 'Victory!' : 'Defeat';
  const name = oppName();
  const texts = {
    flag: won ? `You captured ${name}'s flag.` : `${name} captured your flag.`,
    stuck: won ? `${name} has no pieces left that can move.` : 'You have no pieces left that can move.',
    resign: won ? `${name} resigned.` : 'You resigned.',
  };
  $('#overText').textContent = texts[v.reason] || '';
  const r = app.meta.rematch || {};
  let rt = '';
  if (r[app.mySide] && !r[opp()]) rt = `Waiting for ${name} to accept the rematch…`;
  else if (r[opp()]) rt = `${name} wants a rematch!`;
  $('#rematchText').textContent = rt;
  $('#rematchBtn').disabled = !!r[app.mySide];
  $('#rematchBtn').textContent = r[opp()] && !r[app.mySide] ? 'Accept rematch' : 'Play again';
}

// ---------------------------------------------------------------- chat

function receiveChat(msg) {
  app.chat.push(msg);
  if (app.chat.length > 60) app.chat.shift();
  renderChat();
  if (msg.side !== app.mySide) {
    sfx.select();
    const panelHidden = window.innerWidth <= 860 && !document.body.classList.contains('panel-open');
    if (panelHidden) {
      app.unread++;
      toast(`${msg.name || SIDE_NAME[msg.side]}: ${msg.text}`, '', 4000);
    }
    renderBadge();
  }
}

function renderChat() {
  const list = $('#chatList');
  list.replaceChildren();
  if (!app.chat.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No messages yet.';
    list.append(empty);
    return;
  }
  for (const m of app.chat) {
    const row = document.createElement('div');
    row.className = 'msg';
    const who = document.createElement('b');
    who.className = m.side;
    who.textContent = `${m.side === app.mySide ? 'You' : m.name || SIDE_NAME[m.side]}: `;
    row.append(who, document.createTextNode(m.text));
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}

function renderBadge() {
  const badge = $('#chatBadge');
  badge.hidden = !app.unread;
  badge.textContent = app.unread;
}

// ---------------------------------------------------------------- toasts

function toast(text, kind = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---------------------------------------------------------------- lobby

function shareUrl() {
  return `${location.origin}${location.pathname}?game=${app.code}`;
}

function showView(name, title, text) {
  $('#lobby').hidden = false;
  $('#createView').hidden = name !== 'create';
  $('#inviteView').hidden = name !== 'invite';
  $('#connectView').hidden = name !== 'connect';
  $('#lobbyError').hidden = true;
  if (name === 'connect') {
    $('#connectTitle').textContent = title || 'Connecting…';
    $('#connectText').textContent = text || '';
  }
}

function showLobbyError(text) {
  const el = $('#lobbyError');
  el.textContent = text;
  el.hidden = false;
}

function requireName() {
  const input = $('#nameInput');
  const name = cleanName(input.value);
  if (!name) {
    showLobbyError('Please type your name first, so the other player knows who they are playing.');
    input.focus();
    return null;
  }
  store.set(KEYS.name, name);
  return name;
}

function showInvite(code) {
  app.code = code;
  $('#inviteCode').textContent = code;
  showView('invite');
}

function lobbyBoard() {
  const cells = Array(100).fill(null);
  for (const side of ['red', 'blue']) {
    const army = randomArmy(side);
    homeSquares(side).forEach((sq, i) => { cells[sq] = { id: `L${side}${i}`, side, rank: army[i], revealed: true }; });
  }
  scene.setViewer('red', false);
  scene.setLobby(true);
  scene.sync(cells);
}

function enterGame() {
  app.inGame = true;
  document.body.classList.remove('in-lobby');
  $('#lobby').hidden = true;
  $('#hud').hidden = false;
  scene.setLobby(false);
  scene.clearPieces();
  scene.setViewer(app.mySide, true);
  renderChat();
  renderBadge();
}

function createGame(side) {
  const name = requireName();
  if (!name) return;
  if (typeof Peer === 'undefined') return showLobbyError("Online play couldn't load. Check your internet connection and reload the page.");
  const code = makeCode();
  const record = {
    code, hostSide: side, hostName: name, guestName: null, guestToken: null,
    state: newGame(), chat: [], rematch: {},
  };
  store.set(KEYS.host(code), record);
  history.replaceState(null, '', `?game=${code}`);
  startHost(record);
}

function joinGame(code, name) {
  if (typeof Peer === 'undefined') return showLobbyError("Online play couldn't load. Check your internet connection and reload the page.");
  history.replaceState(null, '', `?game=${code}`);
  startGuest(code, name);
}

function startHost(record, { fallbackToGuest = false } = {}) {
  app.role = 'host';
  app.code = record.code;
  app.mySide = record.hostSide;
  app.myName = record.hostName;
  app.chat = [...(record.chat || [])];
  record.rematch ||= {};
  app.referee = new Referee(record);
  showView('connect', 'Opening your game…', 'Connecting to the game server.');
  const link = new HostLink(record.code, {
    onReady: () => {
      app.net = 'online';
      if (app.inGame) return;
      tabRole.set(record.code, 'host');
      enterGame();
      app.referee.broadcast(null);
    },
    onIdTaken: () => {
      link.destroy();
      if (fallbackToGuest) {
        // Someone else (often another tab) is hosting this game: join it instead.
        app.role = null;
        app.referee = null;
        if (store.get(KEYS.guest(record.code))) startGuest(record.code);
        else showInvite(record.code);
        return;
      }
      showView('create');
      showLobbyError('This game is already open in another window. Close it there, or start a new game.');
    },
    onMessage: onHostMessage,
    onGuestLeft,
    onStatus: (s) => {
      app.net = s;
      if (!app.inGame && s === 'claiming') $('#connectText').textContent = 'Reopening your game — this can take a few seconds…';
    },
  });
  app.link = link;
  link.start({ retryTaken: !fallbackToGuest });
}

function startGuest(code, name) {
  app.role = 'guest';
  app.code = code;
  const rec = store.get(KEYS.guest(code)) || { token: makeToken() };
  rec.name = cleanName(name || rec.name || store.get(KEYS.name, '')) || 'Guest';
  store.set(KEYS.guest(code), rec);
  app.myName = rec.name;
  showView('connect', `Joining game ${code}…`, "Reaching the other player's game.");
  const link = new GuestLink(code, {
    onConnected: () => link.send({ t: 'hello', name: rec.name, token: rec.token }),
    onMessage: onGuestMessage,
    onLost: () => {
      app.net = 'reconnecting';
      if (app.inGame) {
        toast('Lost the connection to the other player. Reconnecting…', 'warn');
        render();
      }
    },
    onStatus: (s) => {
      app.net = s;
      if (app.inGame) return render();
      if (s === 'host-offline') {
        $('#connectTitle').textContent = "Can't reach that game yet";
        $('#connectText').textContent = 'The player who created it needs to have the game open in their browser. Check the code, or ask them to open it — we keep trying.';
      }
    },
  });
  app.link = link;
  link.start();
}

function leaveGame() {
  app.link?.destroy();
  if (app.code) tabRole.clear(app.code);
  location.href = location.pathname;
}

// ---------------------------------------------------------------- UI wiring

function buildRankTable() {
  const notes = { spy: 'beats the Marshal when attacking', scout: 'runs any distance', miner: 'defuses bombs', bomb: 'never moves', flag: 'protect it!' };
  $('#rankTable').innerHTML = RANK_KEYS.map((k) => `<div class="rank-row">${miniPiece('red', k)}
    <div>${RANKS[k].name} <small>×${RANKS[k].count}${notes[k] ? ` · ${notes[k]}` : ''}</small></div></div>`).join('');
}

async function copyLink() {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    $('#shareLink').select();
    document.execCommand('copy');
  }
  toast('Link copied. Paste it into a text or email to your opponent.', 'good');
}

// Full screen hides the browser's own bars. iPhones don't allow it for web
// pages, so the button only shows where it works.
function bindFullscreen() {
  const buttons = document.querySelectorAll('[data-fullscreen]');
  const root = document.documentElement;
  const enter = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (!enter) return;
  const toggle = () => {
    const result = current() ? exit.call(document) : enter.call(root, { navigationUI: 'hide' });
    result?.catch?.(() => toast("Full screen isn't available in this browser.", 'warn'));
  };
  const sync = () => {
    const on = !!current();
    for (const btn of buttons) {
      btn.classList.toggle('active', on);
      btn.title = on ? 'Exit full screen' : 'Full screen';
      btn.setAttribute('aria-label', btn.title);
      if (!btn.querySelector('svg')) btn.textContent = btn.title;
    }
  };
  for (const btn of buttons) {
    btn.hidden = false;
    btn.addEventListener('click', toggle);
  }
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
}

function bindUi() {
  for (const btn of document.querySelectorAll('.side-btn')) {
    btn.addEventListener('click', () => createGame(btn.dataset.side));
  }
  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('#codeInput').value);
    if (!isCode(code)) return showLobbyError('Game codes have 5 letters or numbers, like K7QXM.');
    const name = requireName();
    if (name) joinGame(code, name);
  });
  $('#codeInput').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
  $('#acceptInvite').addEventListener('click', () => {
    const name = requireName();
    if (name) joinGame(app.code, name);
  });
  $('#declineInvite').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    app.code = null;
    showView('create');
  });
  $('#cancelConnect').addEventListener('click', leaveGame);

  $('#shuffleBtn').addEventListener('click', shuffleDraft);
  $('#readyBtn').addEventListener('click', () => {
    const v = app.view;
    if (v.phase === 'over') return sendAction({ t: 'rematch' });
    if (!app.draft) return;
    app.swapFrom = null;
    sendAction({ t: 'deploy', ranks: app.draft.map((d) => d.rank) });
  });

  $('#copyLink').addEventListener('click', copyLink);
  $('#shareLink').addEventListener('focus', (e) => e.target.select());
  $('#shareBtn').addEventListener('click', () => {
    navigator.share?.({ title: TITLE, text: `Join my Stratego game! Code ${app.code}`, url: shareUrl() }).catch(() => {});
  });
  $('#inviteAgainBtn').addEventListener('click', () => {
    app.showInvite = !app.showInvite;
    document.body.classList.remove('panel-open');
    render();
  });
  $('#resignBtn').addEventListener('click', () => {
    if (confirm(`Resign this game? ${oppName()} will win.`)) sendAction({ t: 'resign' });
  });
  $('#leaveBtn').addEventListener('click', () => {
    const v = app.view;
    const msg = v && v.phase !== 'over'
      ? 'Leave this game? You can come back later with the same link, as long as the game stays open.'
      : 'Leave this game and go back to the lobby?';
    if (confirm(msg)) leaveGame();
  });

  $('#rematchBtn').addEventListener('click', () => sendAction({ t: 'rematch' }));
  $('#viewBoardBtn').addEventListener('click', () => {
    $('#overModal').hidden = true;
    render();
  });
  $('#newGameBtn').addEventListener('click', leaveGame);

  bindFullscreen();
  $('#cameraBtn').addEventListener('click', () => scene.setViewer(app.mySide || 'red', true));
  const soundBtn = $('#soundBtn');
  soundBtn.classList.toggle('muted', isMuted());
  soundBtn.addEventListener('click', () => {
    setMuted(!isMuted());
    soundBtn.classList.toggle('muted', isMuted());
    if (!isMuted()) sfx.select();
  });
  $('#panelBtn').addEventListener('click', () => {
    document.body.classList.toggle('panel-open');
    app.unread = 0;
    renderBadge();
  });

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    sendChat(input.value);
    input.value = '';
  });

  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) $(`#${open.dataset.open}`).hidden = false;
    if (e.target.closest('[data-close]') || e.target.id === 'rulesModal') $('#rulesModal').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $('#rulesModal').hidden = true;
    if (app.selected != null || app.swapFrom != null) {
      app.selected = null;
      app.swapFrom = null;
      render();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) document.title = TITLE;
  });
  window.addEventListener('resize', () => app.inGame && updateInsets());
}

// ---------------------------------------------------------------- start

async function boot() {
  try {
    await Promise.race([
      Promise.all([document.fonts.load('700 64px Cinzel'), document.fonts.load('700 24px Inter')]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch { /* fall back to system fonts */ }

  scene = new BoardScene($('#board'));
  scene.onSquareClick = onSquareClick;
  scene.onHover = onHover;
  window.addEventListener('pointerdown', (e) => {
    if (e.target.id === 'board') document.body.classList.remove('panel-open');
  });
  lobbyBoard();
  bindUi();
  buildRankTable();
  $('#nameInput').value = store.get(KEYS.name, '');

  const code = normalizeCode(new URLSearchParams(location.search).get('game'));
  if (!isCode(code)) return showView('create');
  if (typeof Peer === 'undefined') {
    showView('create');
    return showLobbyError("Online play couldn't load. Check your internet connection and reload the page.");
  }
  const role = tabRole.get(code);
  const hostRecord = store.get(KEYS.host(code));
  if (hostRecord && role !== 'guest') return startHost(hostRecord, { fallbackToGuest: role !== 'host' });
  if (role === 'guest' || store.get(KEYS.guest(code))) return startGuest(code);
  showInvite(code);
}

boot();
