// The 3D board, built with three.js. It only draws what it is told: main.js
// hands it the cells to show and it animates the differences.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RANKS, SIZE, isLake, xy } from './game.js';

const DISPLAY_FONT = '"Cinzel", Georgia, "Times New Roman", serif';
const UI_FONT = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';

const STYLE = {
  red:  { body: '#b3312a', base: '#5c1612', hi: '#de5548', lo: '#8c211b', ink: '#fff3e2' },
  blue: { body: '#2b5db5', base: '#132f66', hi: '#4f86e2', lo: '#1c418a', ink: '#eef4ff' },
};
const GOLD = '#f2c26b';

const FRAME = 0.6;
const BOARD = SIZE + FRAME * 2;
const P = { w: 0.84, h: 0.74, d: 0.34, baseH: 0.07, lean: THREE.MathUtils.degToRad(10) };

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const hopDuration = (dist) => 240 + dist * 90;

export function squareCenter(i, out = new THREE.Vector3()) {
  const [x, y] = xy(i);
  return out.set(x - 4.5, 0, y - 4.5);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function texture(canvas, { repeat = false } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Simple seeded random so the board looks the same every time.
function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// ---------------------------------------------------------------- icons

function drawBomb(g, cx, cy, s, color) {
  g.save();
  g.fillStyle = color;
  g.strokeStyle = color;
  g.beginPath();
  g.arc(cx - s * 0.04, cy + s * 0.08, s * 0.36, 0, Math.PI * 2);
  g.fill();
  g.save();
  g.translate(cx + s * 0.2, cy - s * 0.2);
  g.rotate(Math.PI / 4);
  g.fillRect(-s * 0.09, -s * 0.1, s * 0.18, s * 0.16);
  g.restore();
  g.lineWidth = s * 0.045;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx + s * 0.26, cy - s * 0.26);
  g.quadraticCurveTo(cx + s * 0.4, cy - s * 0.46, cx + s * 0.3, cy - s * 0.5);
  g.stroke();
  g.fillStyle = GOLD;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = i % 2 ? s * 0.07 : s * 0.12;
    g.beginPath();
    g.arc(cx + s * 0.3 + Math.cos(a) * r, cy - s * 0.52 + Math.sin(a) * r, s * 0.025, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.arc(cx - s * 0.16, cy - s * 0.04, s * 0.09, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawFlag(g, cx, cy, s, color) {
  g.save();
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineWidth = s * 0.06;
  g.lineCap = 'round';
  const px = cx - s * 0.28;
  g.beginPath();
  g.moveTo(px, cy - s * 0.48);
  g.lineTo(px, cy + s * 0.46);
  g.stroke();
  g.beginPath();
  g.moveTo(px, cy - s * 0.44);
  g.bezierCurveTo(px + s * 0.2, cy - s * 0.54, px + s * 0.34, cy - s * 0.3, px + s * 0.58, cy - s * 0.4);
  g.lineTo(px + s * 0.58, cy - s * 0.02);
  g.bezierCurveTo(px + s * 0.34, cy + s * 0.08, px + s * 0.2, cy - s * 0.16, px, cy - s * 0.06);
  g.closePath();
  g.fill();
  g.beginPath();
  g.ellipse(px, cy + s * 0.47, s * 0.18, s * 0.05, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawEye(g, cx, cy, s, color) {
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = s * 0.12;
  g.beginPath();
  g.moveTo(cx - s, cy);
  g.quadraticCurveTo(cx, cy - s * 0.9, cx + s, cy);
  g.quadraticCurveTo(cx, cy + s * 0.9, cx - s, cy);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, s * 0.32, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawShield(g, cx, cy, s, color) {
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = s * 0.06;
  g.beginPath();
  g.moveTo(cx, cy - s * 0.5);
  g.lineTo(cx + s * 0.42, cy - s * 0.36);
  g.quadraticCurveTo(cx + s * 0.44, cy + s * 0.2, cx, cy + s * 0.52);
  g.quadraticCurveTo(cx - s * 0.44, cy + s * 0.2, cx - s * 0.42, cy - s * 0.36);
  g.closePath();
  g.stroke();
  // star
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? s * 0.09 : s * 0.22;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(cx + Math.cos(a) * r, cy - s * 0.02 + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.restore();
}

// ---------------------------------------------------------------- piece textures

const texCache = new Map();
const matCache = new Map();

function cached(key, make) {
  if (!texCache.has(key)) texCache.set(key, make());
  return texCache.get(key);
}

function faceBackground(g, w, h, side) {
  const st = STYLE[side];
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, st.hi);
  grad.addColorStop(1, st.lo);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.32)';
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(12, 12, w - 24, h - 24, 18);
  g.stroke();
}

function rankFaceTexture(side, rank, seenMark) {
  return cached(`face:${side}:${rank}:${seenMark}`, () => {
    const [c, g] = makeCanvas(288, 248);
    const st = STYLE[side];
    const info = RANKS[rank];
    faceBackground(g, 288, 248, side);
    g.fillStyle = st.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 8;
    g.shadowOffsetY = 3;
    if (rank === 'bomb') drawBomb(g, 144, 104, 150, st.ink);
    else if (rank === 'flag') drawFlag(g, 150, 102, 140, st.ink);
    else {
      g.font = `700 ${info.label.length > 1 ? 112 : 128}px ${DISPLAY_FONT}`;
      g.fillText(info.label, 144, 108);
    }
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
    g.font = `700 25px ${UI_FONT}`;
    if ('letterSpacing' in g) g.letterSpacing = '3px';
    g.fillText(info.name.toUpperCase(), 144, 206);
    if (seenMark) drawEye(g, 46, 42, 16, GOLD);
    return texture(c);
  });
}

function emblemTexture(side) {
  return cached(`emblem:${side}`, () => {
    const [c, g] = makeCanvas(288, 248);
    faceBackground(g, 288, 248, side);
    drawShield(g, 144, 124, 150, 'rgba(242,194,107,0.85)');
    return texture(c);
  });
}

function topTexture(side, rank) {
  return cached(`top:${side}:${rank}`, () => {
    const [c, g] = makeCanvas(256, 92);
    const st = STYLE[side];
    g.fillStyle = st.body;
    g.fillRect(0, 0, 256, 92);
    g.fillStyle = st.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (rank === 'bomb') drawBomb(g, 128, 46, 70, st.ink);
    else if (rank === 'flag') drawFlag(g, 132, 46, 66, st.ink);
    else {
      g.font = `700 64px ${DISPLAY_FONT}`;
      g.fillText(RANKS[rank].label, 128, 50);
    }
    return texture(c);
  });
}

function faceMaterial(tex) {
  if (!matCache.has(tex.uuid)) {
    matCache.set(tex.uuid, new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.6, metalness: 0, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.18,
    }));
  }
  return matCache.get(tex.uuid);
}

// ---------------------------------------------------------------- shared geometry & materials

const GEO = {
  block: new RoundedBoxGeometry(P.w, P.h, P.d, 3, 0.05),
  base: new RoundedBoxGeometry(P.w + 0.06, P.baseH, P.d + 0.2, 2, 0.025),
  face: new THREE.PlaneGeometry(P.w - 0.12, P.h - 0.12),
  top: new THREE.PlaneGeometry(P.w - 0.12, P.d - 0.08),
  marker: new THREE.PlaneGeometry(0.94, 0.94),
};

const BODY_MAT = {};
const SELECT_MAT = {};
const BASE_MAT = {};
for (const side of ['red', 'blue']) {
  BODY_MAT[side] = new THREE.MeshStandardMaterial({ color: STYLE[side].body, roughness: 0.45, metalness: 0.05 });
  SELECT_MAT[side] = new THREE.MeshStandardMaterial({
    color: STYLE[side].body, roughness: 0.4, metalness: 0.05, emissive: GOLD, emissiveIntensity: 0.35,
  });
  BASE_MAT[side] = new THREE.MeshStandardMaterial({ color: STYLE[side].base, roughness: 0.6 });
}

class Piece {
  constructor(data) {
    this.id = data.id;
    this.side = data.side;
    this.square = -1;
    this.dead = false;
    this.paintKey = '';
    this.shownRank = null; // an enemy rank shown just for the length of a battle
    this.flips = 0;

    this.root = new THREE.Group();
    this.lift = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.lift);
    this.root.rotation.y = data.side === 'red' ? 0 : Math.PI; // labelled face looks at its owner

    const base = new THREE.Mesh(GEO.base, BASE_MAT[data.side]);
    base.position.y = P.baseH / 2;
    base.castShadow = true;
    base.receiveShadow = true;
    this.lift.add(base);

    this.body.position.y = P.baseH;
    this.body.rotation.x = -P.lean;
    this.lift.add(this.body);

    this.block = new THREE.Mesh(GEO.block, BODY_MAT[data.side]);
    this.block.position.y = P.h / 2;
    this.block.castShadow = true;
    this.body.add(this.block);

    this.front = new THREE.Mesh(GEO.face);
    this.front.position.set(0, P.h / 2, P.d / 2 + 0.004);
    this.back = new THREE.Mesh(GEO.face);
    this.back.position.set(0, P.h / 2, -P.d / 2 - 0.004);
    this.back.rotation.y = Math.PI;
    this.top = new THREE.Mesh(GEO.top);
    this.top.position.y = P.h + 0.004;
    this.body.add(this.front, this.back, this.top);

    this.root.traverse((o) => { o.userData.piece = this; });
  }

  paint(data, viewer, showSeen) {
    this.data = data;
    const rank = data.rank || this.shownRank;
    const known = !!rank;
    const mine = data.side === viewer;
    const seen = mine && known && data.seen && showSeen;
    const key = `${rank}|${viewer}|${seen}`;
    if (key === this.paintKey) return;
    this.paintKey = key;
    const emblem = faceMaterial(emblemTexture(data.side));
    this.front.material = known ? faceMaterial(rankFaceTexture(data.side, rank, seen)) : emblem;
    this.back.material = known && !mine ? faceMaterial(rankFaceTexture(data.side, rank, false)) : emblem;
    this.top.visible = known;
    if (known) {
      this.top.material = faceMaterial(topTexture(data.side, rank));
      this.top.rotation.set(-Math.PI / 2, 0, mine ? 0 : Math.PI);
    }
  }

  setSelected(on) {
    this.block.material = on ? SELECT_MAT[this.side] : BODY_MAT[this.side];
  }
}

// ---------------------------------------------------------------- board textures

function boardTexture() {
  const S = 2048;
  const u = S / BOARD;
  const [c, g] = makeCanvas(S, S);
  const rnd = seeded(7);

  // Wooden frame with grain.
  g.fillStyle = '#6a4325';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    const y = rnd() * S;
    g.strokeStyle = `rgba(${rnd() < 0.5 ? '40,22,10' : '150,100,60'},${0.05 + rnd() * 0.12})`;
    g.lineWidth = 1 + rnd() * 3;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(S * 0.3, y + (rnd() - 0.5) * 30, S * 0.7, y + (rnd() - 0.5) * 30, S, y + (rnd() - 0.5) * 20);
    g.stroke();
  }

  // Playing field.
  const o = FRAME * u;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const neutral = y === 4 || y === 5;
      const light = (x + y) % 2 === 0;
      g.fillStyle = neutral ? (light ? '#6c9447' : '#658d42') : light ? '#5d8a3c' : '#56823a';
      g.fillRect(o + x * u, o + y * u, u + 1, u + 1);
    }
  }
  for (let i = 0; i < 26000; i++) {
    const x = o + rnd() * SIZE * u;
    const y = o + rnd() * SIZE * u;
    g.fillStyle = rnd() < 0.5 ? `rgba(30,60,20,${rnd() * 0.25})` : `rgba(170,210,120,${rnd() * 0.18})`;
    g.fillRect(x, y, 2 + rnd() * 2, 4 + rnd() * 6);
  }

  // Lakes: sandy shore, deep water underneath the animated surface.
  for (const lx of [2, 6]) {
    const x0 = o + lx * u;
    const y0 = o + 4 * u;
    g.fillStyle = '#c8b07a';
    g.beginPath();
    g.roundRect(x0 + 4, y0 + 4, u * 2 - 8, u * 2 - 8, u * 0.35);
    g.fill();
    g.fillStyle = '#15476d';
    g.beginPath();
    g.roundRect(x0 + u * 0.1, y0 + u * 0.1, u * 1.8, u * 1.8, u * 0.3);
    g.fill();
  }

  // Grid lines.
  g.strokeStyle = 'rgba(18,32,10,0.55)';
  g.lineWidth = 3;
  for (let i = 0; i <= SIZE; i++) {
    for (const [ax, ay, bx, by] of [[o + i * u, o, o + i * u, o + SIZE * u], [o, o + i * u, o + SIZE * u, o + i * u]]) {
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
    }
  }
  // Re-cover grid lines that cross the lakes.
  for (const lx of [2, 6]) {
    g.fillStyle = '#15476d';
    g.beginPath();
    g.roundRect(o + lx * u + u * 0.1, o + 4 * u + u * 0.1, u * 1.8, u * 1.8, u * 0.3);
    g.fill();
  }

  // Gold inlay around the field.
  g.strokeStyle = '#c9a35a';
  g.lineWidth = 6;
  g.strokeRect(o - 10, o - 10, SIZE * u + 20, SIZE * u + 20);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 3;
  g.strokeRect(o - 2, o - 2, SIZE * u + 4, SIZE * u + 4);

  // Coordinates, readable from each player's side of the table.
  g.fillStyle = '#f0dcb0';
  g.font = `700 ${Math.round(u * 0.32)}px ${DISPLAY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const label = (text, x, y, flip) => {
    g.save();
    g.translate(x, y);
    if (flip) g.rotate(Math.PI);
    g.fillText(text, 0, 0);
    g.restore();
  };
  for (let i = 0; i < SIZE; i++) {
    const letter = 'ABCDEFGHIJ'[i];
    const cx = o + (i + 0.5) * u;
    label(letter, cx, S - o / 2, false);
    label(letter, cx, o / 2, true);
    const num = String(SIZE - i);
    const cy = o + (i + 0.5) * u;
    label(num, o / 2, cy, false);
    label(num, S - o / 2, cy, true);
  }
  return texture(c);
}

function rippleTexture() {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#2a78b0';
  g.fillRect(0, 0, 256, 256);
  const rnd = seeded(3);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const w = 20 + rnd() * 50;
    g.strokeStyle = `rgba(200,235,255,${0.08 + rnd() * 0.18})`;
    g.lineWidth = 1.5 + rnd() * 2;
    g.beginPath();
    g.moveTo(x - w / 2, y);
    g.quadraticCurveTo(x, y - 6, x + w / 2, y);
    g.stroke();
    // wrap around so the texture tiles
    g.beginPath();
    g.moveTo(x - w / 2 - 256, y);
    g.quadraticCurveTo(x - 256, y - 6, x + w / 2 - 256, y);
    g.stroke();
  }
  return texture(c, { repeat: true });
}

function markerTexture(fill) {
  const [c, g] = makeCanvas(128, 128);
  g.shadowColor = '#fff';
  if (fill) {
    g.shadowBlur = 18;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.roundRect(14, 14, 100, 100, 16);
    g.fill();
  } else {
    g.shadowBlur = 14;
    g.strokeStyle = '#fff';
    g.lineWidth = 9;
    g.beginPath();
    g.roundRect(12, 12, 104, 104, 18);
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.beginPath();
    g.roundRect(12, 12, 104, 104, 18);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- the scene

export class BoardScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.viewer = 'red';
    this.pieces = new Map();
    this.tweens = [];
    this.insets = { top: 0, right: 0, bottom: 0 };
    this.onSquareClick = () => {};
    this.onHover = () => {};
    this.showSeen = true;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200);

    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x3b2a1a, 1.5));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    sun.position.set(5, 14, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x9db8ff, 0.6);
    rim.position.set(-6, 6, -8);
    scene.add(rim);

    this.buildBoard();
    this.buildMarkers();

    this.piecesGroup = new THREE.Group();
    scene.add(this.piecesGroup);

    const controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 7;
    controls.maxDistance = 48;
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(78);
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.8;
    controls.autoRotateSpeed = 0.6;
    controls.addEventListener('start', () => {
      this.userMoved = true;
      this.cameraTween = null;
    });
    this.controls = controls;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindPointer();

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.frame(false);

    this.clock = new THREE.Clock();
    renderer.setAnimationLoop(() => this.tick());
  }

  buildBoard() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x4a2d17, roughness: 0.7 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(BOARD, 0.42, BOARD), wood);
    base.position.y = -0.21;
    base.castShadow = true;
    base.receiveShadow = true;
    this.scene.add(base);

    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD, BOARD),
      new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.85 }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 0.002;
    surface.receiveShadow = true;
    surface.userData.surface = true;
    this.surface = surface;
    this.scene.add(surface);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.35 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.42;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.ripples = rippleTexture();
    this.ripples.repeat.set(1.6, 1.6);
    const water = new THREE.MeshStandardMaterial({
      map: this.ripples, roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.9,
    });
    const rock = new THREE.MeshStandardMaterial({ color: 0x8a8577, roughness: 0.9, flatShading: true });
    const pad = new THREE.MeshStandardMaterial({ color: 0x4f8a3a, roughness: 0.7 });
    const rnd = seeded(11);
    for (const cx of [-2, 2]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1.78, 1.78), water);
      w.rotation.x = -Math.PI / 2;
      w.position.set(cx, 0.012, 0);
      w.receiveShadow = true;
      this.scene.add(w);
      for (let i = 0; i < 5; i++) {
        const r = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06 + rnd() * 0.07, 0), rock);
        const a = rnd() * Math.PI * 2;
        r.position.set(cx + Math.cos(a) * 0.92, 0.03, Math.sin(a) * 0.92);
        r.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
        r.castShadow = true;
        this.scene.add(r);
      }
      for (let i = 0; i < 3; i++) {
        const lily = new THREE.Mesh(new THREE.CylinderGeometry(0.1 + rnd() * 0.06, 0.1, 0.01, 14, 1, false, 0.4, Math.PI * 1.8), pad);
        lily.position.set(cx + (rnd() - 0.5) * 1.2, 0.02, (rnd() - 0.5) * 1.2);
        lily.rotation.y = rnd() * Math.PI * 2;
        this.scene.add(lily);
      }
    }
  }

  buildMarkers() {
    this.markerGroup = new THREE.Group();
    this.scene.add(this.markerGroup);
    this.markerTex = { ring: markerTexture(false), fill: markerTexture(true) };
    this.markerPool = [];
    this.markersUsed = 0;
  }

  marker(sq, color, opacity, kind = 'ring') {
    let m = this.markerPool[this.markersUsed];
    if (!m) {
      m = new THREE.Mesh(GEO.marker, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 1;
      this.markerPool.push(m);
      this.markerGroup.add(m);
    }
    this.markersUsed++;
    m.visible = true;
    if (m.material.map !== this.markerTex[kind]) {
      m.material.map = this.markerTex[kind];
      m.material.needsUpdate = true;
    }
    m.material.color.set(color);
    m.material.opacity = opacity;
    squareCenter(sq, m.position);
    m.position.y = 0.02;
    m.scale.setScalar(1);
    return m;
  }

  // marks: { zone: [sq], lastMove: {from,to}, selected: sq, targets: [{sq, attack}], hover: sq }
  setMarks(marks) {
    this.markersUsed = 0;
    for (const sq of marks.zone || []) this.marker(sq, GOLD, 0.16, 'fill');
    if (marks.lastMove) {
      this.marker(marks.lastMove.from, '#ffffff', 0.22, 'fill');
      this.marker(marks.lastMove.to, '#ffffff', 0.4, 'ring');
    }
    if (marks.selected != null) this.marker(marks.selected, GOLD, 1, 'ring');
    for (const t of marks.targets || []) {
      this.marker(t.sq, t.attack ? '#ff5b4a' : '#8dff9a', t.attack ? 0.95 : 0.8, 'ring');
    }
    if (marks.hover != null) this.marker(marks.hover, '#ffffff', 0.35, 'ring');
    for (let i = this.markersUsed; i < this.markerPool.length; i++) this.markerPool[i].visible = false;

    const selectedId = marks.selected != null ? this.idAt(marks.selected) : null;
    for (const piece of this.pieces.values()) {
      const on = piece.id === selectedId;
      if (on !== !!piece.isSelected) {
        piece.isSelected = on;
        piece.setSelected(on);
        this.tween({ duration: 180, from: piece.lift.position.y, to: on ? 0.16 : 0, update: (v) => { piece.lift.position.y = v; } });
      }
    }
  }

  idAt(sq) {
    for (const p of this.pieces.values()) if (p.square === sq && !p.dead) return p.id;
    return null;
  }

  // ------------------------------------------------------------ pieces

  // cells: 100 entries of null | { id, side, rank, seen }.
  // event: the move that produced these cells, so it can be animated.
  // Returns how long the animation runs, in ms.
  sync(cells, event = null) {
    const seen = new Set();
    const dying = new Map();
    const fight = event && event.kind === 'attack' ? this.fightTiming(event) : null;
    if (fight) {
      if (event.result !== 'attacker') dying.set(event.attacker.id, event.attacker);
      if (event.result !== 'defender') dying.set(event.defender.id, event.defender);
    }

    cells.forEach((data, sq) => {
      if (!data) return;
      seen.add(data.id);
      let piece = this.pieces.get(data.id);
      if (!piece || piece.dead) {
        piece = new Piece(data);
        this.pieces.set(data.id, piece);
        this.piecesGroup.add(piece.root);
        squareCenter(sq, piece.root.position);
        piece.square = sq;
      }
      const survivor = fight && (event.result === 'attacker' ? event.attacker : event.result === 'defender' ? event.defender : null);
      if (survivor && survivor.id === data.id && !data.rank) {
        // Show the enemy's rank for the battle, then turn it face-down again.
        piece.shownRank = survivor.rank;
        this.flipDown(piece, fight.hideAt);
      }
      piece.paint(data, this.viewer, this.showSeen);
      if (piece.square !== sq) {
        const from = piece.square;
        piece.square = sq;
        if (fight && event.attacker.id === data.id) {
          // Close in, wait for the defender to fall, then take the square.
          this.hop(piece, squareCenter(from), fight.strike, { height: 0.3 });
          this.hop(piece, fight.strike, squareCenter(sq), { delay: fight.advanceAt, height: 0.12 });
        } else {
          this.hop(piece, squareCenter(from), squareCenter(sq));
        }
      }
    });

    for (const [id, piece] of this.pieces) {
      if (seen.has(id) || piece.dead) continue;
      if (dying.has(id)) {
        const info = dying.get(id);
        piece.paint({ id, side: info.side, rank: info.rank }, this.viewer, false);
        if (id === event.attacker.id) this.hop(piece, squareCenter(event.from), fight.strike, { height: 0.3 });
        this.sink(piece, fight.sinkAt);
      } else {
        this.removePiece(piece);
      }
    }

    if (!fight) return 0;
    this.burst(event.to, fight.clashAt);
    return fight.advanceAt + 300;
  }

  fightTiming(event) {
    const a = squareCenter(event.from);
    const b = squareCenter(event.to);
    const strike = b.clone().add(a.clone().sub(b).setLength(0.55));
    const clashAt = hopDuration(a.distanceTo(strike));
    return { strike, clashAt, sinkAt: clashAt + 350, advanceAt: clashAt + 800, hideAt: clashAt + 2300 };
  }

  // Spin the piece edge-on, swap to its plain back, and spin it home.
  flipDown(piece, delay) {
    const flip = ++piece.flips;
    let swapped = false;
    this.tween({
      delay,
      duration: 650,
      update: (t) => {
        if (flip !== piece.flips) return;
        if (!swapped && t >= 0.5) {
          swapped = true;
          piece.shownRank = null;
          piece.paint(piece.data, this.viewer, this.showSeen);
        }
        piece.lift.rotation.y = Math.sin(Math.PI * t) * (Math.PI / 2);
        piece.lift.position.y = Math.sin(Math.PI * t) * 0.18;
      },
    });
  }

  removePiece(piece) {
    piece.dead = true;
    this.piecesGroup.remove(piece.root);
    this.pieces.delete(piece.id);
  }

  hop(piece, a, b, { delay = 0, height = 0.25 } = {}) {
    const dist = a.distanceTo(b);
    this.tween({
      delay,
      duration: hopDuration(dist),
      update: (t) => {
        piece.root.position.lerpVectors(a, b, t);
        piece.root.position.y = Math.sin(Math.PI * t) * (height + Math.min(dist, 4) * 0.05);
      },
    });
  }

  sink(piece, delay) {
    piece.dead = true;
    const spin = (Math.random() - 0.5) * 0.8;
    this.tween({
      delay,
      duration: 650,
      update: (t) => {
        piece.root.position.y = -t * 1.1;
        piece.root.rotation.z = spin * t;
        piece.root.scale.setScalar(1 - t * 0.35);
      },
      done: () => {
        this.piecesGroup.remove(piece.root);
        if (this.pieces.get(piece.id) === piece) this.pieces.delete(piece.id);
      },
    });
  }

  burst(sq, delay) {
    const m = new THREE.Mesh(GEO.marker, new THREE.MeshBasicMaterial({
      map: this.markerTex.ring, color: GOLD, transparent: true, depthWrite: false, opacity: 0,
    }));
    m.rotation.x = -Math.PI / 2;
    squareCenter(sq, m.position);
    m.position.y = 0.05;
    this.scene.add(m);
    this.tween({
      delay,
      duration: 650,
      update: (t) => {
        m.scale.setScalar(0.6 + t * 1.4);
        m.material.opacity = 1 - t;
      },
      done: () => {
        this.scene.remove(m);
        m.material.dispose();
      },
    });
  }

  clearPieces() {
    for (const piece of [...this.pieces.values()]) this.removePiece(piece);
  }

  // ------------------------------------------------------------ camera

  setViewer(side, animate = true) {
    this.viewer = side || 'red';
    for (const piece of this.pieces.values()) piece.paintKey = '';
    this.userMoved = false;
    this.frame(animate);
  }

  setLobby(on) {
    this.controls.autoRotate = on;
    this.controls.enableZoom = !on;
  }

  setInsets(insets) {
    this.insets = { ...this.insets, ...insets };
    this.applyViewOffset();
    if (!this.userMoved) this.frame(true);
  }

  cameraGoal() {
    const W = this.canvas.clientWidth || 1;
    const H = this.canvas.clientHeight || 1;
    const effW = Math.max(200, W - this.insets.right);
    const effH = Math.max(200, H - this.insets.top - this.insets.bottom);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const elev = THREE.MathUtils.degToRad(effW / effH < 0.9 ? 66 : 54);
    const halfDepth = (BOARD / 2) * Math.sin(elev) + 0.8;
    const dist = Math.max(6.3 / (tanHalf * (effW / H)), halfDepth / (tanHalf * (effH / H))) * 1.04;
    const dir = this.viewer === 'blue' ? -1 : 1;
    return {
      position: new THREE.Vector3(0, dist * Math.sin(elev), dir * dist * Math.cos(elev)),
      target: new THREE.Vector3(0, 0, dir * 0.35),
    };
  }

  frame(animate = true) {
    const goal = this.cameraGoal();
    if (!animate) {
      this.camera.position.copy(goal.position);
      this.controls.target.copy(goal.target);
      this.controls.update();
      return;
    }
    // Swing around the board on a sphere rather than cutting through it.
    const fromTarget = this.controls.target.clone();
    const a = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(fromTarget));
    const b = new THREE.Spherical().setFromVector3(goal.position.clone().sub(goal.target));
    let dTheta = b.theta - a.theta;
    if (dTheta > Math.PI) dTheta -= Math.PI * 2;
    if (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const s = new THREE.Spherical();
    this.cameraTween = this.tween({
      duration: 1100,
      update: (t) => {
        if (this.cameraTween === null) return;
        s.set(a.radius + (b.radius - a.radius) * t, a.phi + (b.phi - a.phi) * t, a.theta + dTheta * t);
        this.controls.target.lerpVectors(fromTarget, goal.target, t);
        this.camera.position.setFromSpherical(s).add(this.controls.target);
      },
    });
  }

  // Shift the picture so the board is centred in the space the HUD leaves free.
  applyViewOffset() {
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    if (!W || !H) return;
    const { top, right, bottom } = this.insets;
    this.camera.aspect = W / H;
    this.camera.setViewOffset(W, H, right / 2, -(top - bottom) / 2, W, H);
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    if (!W || !H) return;
    this.renderer.setSize(W, H, false);
    this.applyViewOffset();
    if (!this.userMoved && !this.cameraTween) this.frame(false);
  }

  // ------------------------------------------------------------ input

  bindPointer() {
    let down = null;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    c.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 700;
      down = null;
      if (moved < 8 && quick) {
        const squares = this.pick(e);
        if (squares.length) this.onSquareClick(squares);
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      this.onHover(this.pick(e));
    });
    c.addEventListener('pointerleave', () => this.onHover([]));
  }

  // Every square under the pointer, nearest first (a piece can hide the
  // square behind it, so the caller picks the one that makes sense).
  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([this.surface, this.piecesGroup], true);
    const squares = [];
    for (const h of hits) {
      const piece = h.object.userData.piece;
      if (piece) {
        if (!piece.dead && !squares.includes(piece.square)) squares.push(piece.square);
        continue;
      }
      if (h.object.userData.surface) {
        const x = Math.floor(h.point.x + 5);
        const y = Math.floor(h.point.z + 5);
        const sq = y * SIZE + x;
        if (x >= 0 && y >= 0 && x < SIZE && y < SIZE && !isLake(sq) && !squares.includes(sq)) squares.push(sq);
        break;
      }
    }
    return squares;
  }

  // ------------------------------------------------------------ animation loop

  tween({ delay = 0, duration, from = 0, to = 1, update, done }) {
    const tw = { start: performance.now() + delay, duration, from, to, update, done };
    this.tweens.push(tw);
    return tw;
  }

  tick() {
    const now = performance.now();
    const dt = this.clock.getDelta();
    this.tweens = this.tweens.filter((tw) => {
      if (now < tw.start) return true;
      const t = Math.min(1, (now - tw.start) / tw.duration);
      tw.update(tw.from + (tw.to - tw.from) * ease(t));
      if (t >= 1) {
        tw.done?.();
        return false;
      }
      return true;
    });
    this.ripples.offset.x += dt * 0.02;
    this.ripples.offset.y += dt * 0.012;
    if (!this.cameraTween || !this.tweens.includes(this.cameraTween)) {
      this.cameraTween = null;
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);
  }
}
