import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FLOOR, LOT, MAIN_STREET, heightOf, rangeStart, roomSpot, startOfToday, type Building, type City, type CityRange, type Floor, type Room } from "../lib/city";

/**
 * The city in real 3D (three.js): towers with lit windows that glow, street
 * lamps, a sky, and a camera you can turn to any angle. Click a building to
 * open its project; hover a window to see the task it was.
 */

export interface SceneTheme {
  skyTop: string;
  skyBottom: string;
  fog: string;
  ground: string;
  street: string;
  wall: string;
  roof: string;
  dark: string;
  lit: string;
  fresh: string;
  beacon: string;
  crane: string;
  lamp: string;
  hemiSky: string;
  hemiGround: string;
  moon: string;
  stars: boolean;
  bloom: number;
}

export const NIGHT_3D: SceneTheme = {
  skyTop: "#05060c",
  skyBottom: "#1b1f36",
  fog: "#10121d",
  ground: "#10121b",
  street: "#1d2132",
  wall: "#2c3048",
  roof: "#3a3f5c",
  dark: "#151827",
  lit: "#d29a45",
  fresh: "#ffd27a",
  beacon: "#b9b2ff",
  crane: "#6b7090",
  lamp: "#ffd27a",
  hemiSky: "#5b6390",
  hemiGround: "#0b0c12",
  moon: "#c9d2ff",
  stars: true,
  bloom: 0.9,
};

export const DUSK_3D: SceneTheme = {
  skyTop: "#f0b48c",
  skyBottom: "#fde9d9",
  fog: "#f6d7c2",
  ground: "#e8d2c3",
  street: "#d9bfae",
  wall: "#8e6c76",
  roof: "#a6858d",
  dark: "#5c4650",
  lit: "#dba552",
  fresh: "#ffcf6e",
  beacon: "#6a62ea",
  crane: "#8b6c73",
  lamp: "#f2a65a",
  hemiSky: "#ffe6d3",
  hemiGround: "#9a7a82",
  moon: "#fff1e2",
  stars: false,
  bloom: 0.35,
};

export interface Picked {
  key: string;
  /** The room (task) under the pointer, lit or dark. */
  room: Room | null;
  /** Which floor it's on ("1st Floor: Travel"). */
  floor: string | null;
  x: number;
  y: number;
}

interface Built {
  scene: THREE.Scene;
  /** Outline (tint) the building under the pointer. */
  setHover: (key: string | null) => void;
  /** Building floors, for picking (userData.key, userData.floor). */
  bodies: THREE.Mesh[];
  /** Rooms (windows): the instanced meshes and which room each instance is. */
  windowMeshes: { mesh: THREE.InstancedMesh; rooms: { room: Room; key: string; floor: string }[] }[];
  labels: CSS2DObject[];
  radius: number;
  center: THREE.Vector3;
  /** Move the traffic along by `dt` seconds. False when nothing moves. */
  tick: (dt: number) => boolean;
  dispose: () => void;
}

const SIDES: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

type Keep = <T extends { dispose: () => void }>(x: T) => T;

/** Build the whole city as a three.js scene. */
export function buildScene(city: City, theme: SceneTheme, range: CityRange, now: Date, opts: { labels: boolean; mayor?: string | null; still?: boolean }): Built {
  const scene = new THREE.Scene();
  const disposables: { dispose: () => void }[] = [];
  const keep: Keep = (x) => {
    disposables.push(x);
    return x;
  };
  scene.fog = new THREE.Fog(theme.fog, 40, 140);

  // Sky: a big sphere with a gradient, and stars at night.
  const skyGeo = keep(new THREE.SphereGeometry(200, 32, 16));
  const skyMat = keep(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(theme.skyTop) }, bottom: { value: new THREE.Color(theme.skyBottom) } },
      vertexShader: "varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader:
        "uniform vec3 top; uniform vec3 bottom; varying vec3 vPos; void main(){ float h = clamp(normalize(vPos).y * 1.6 + 0.15, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }",
    }),
  );
  scene.add(new THREE.Mesh(skyGeo, skyMat));
  if (theme.stars) {
    const pts: number[] = [];
    let s = 7;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 900; i++) {
      const u = rnd() * Math.PI * 2;
      const v = 0.08 + rnd() * 1.3;
      pts.push(180 * Math.cos(u) * Math.cos(v), 180 * Math.sin(v), 180 * Math.sin(u) * Math.cos(v));
    }
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const m = keep(new THREE.PointsMaterial({ color: "#cfd3ff", size: 0.9, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.8 }));
    scene.add(new THREE.Points(g, m));
  }

  // Light: soft sky light and a moon (or low sun) casting shadows.
  scene.add(new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, 1.1));
  const moon = new THREE.DirectionalLight(theme.moon, 1.3);
  moon.position.set(-18, 30, 12);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.bias = -0.0008;

  // Ground and streets: a street on every lot line, round the edge too.
  let gMin = 0;
  let gMax = 0;
  for (const b of city.buildings) {
    gMin = Math.min(gMin, b.gx, b.gy);
    gMax = Math.max(gMax, b.gx, b.gy);
  }
  const g0 = gMin * LOT - LOT / 2;
  const g1 = gMax * LOT + LOT / 2;
  const span = g1 - g0;
  const mid = (g0 + g1) / 2;
  const groundGeo = keep(new THREE.BoxGeometry(span + 1.4, 0.3, span + 1.4));
  const groundMat = keep(new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 0.95 }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.set(mid, -0.15, mid);
  ground.receiveShadow = true;
  scene.add(ground);
  const streetMat = keep(new THREE.MeshStandardMaterial({ color: theme.street, roughness: 0.9 }));
  const lines: number[] = [];
  for (let gi = gMin; gi <= gMax + 1; gi++) lines.push((gi - 0.5) * LOT);
  for (const s of lines) {
    for (const along of [true, false]) {
      const geo = keep(new THREE.BoxGeometry(along ? 0.46 : span + 0.46, 0.02, along ? span + 0.46 : 0.46));
      const st = new THREE.Mesh(geo, streetMat);
      st.position.set(along ? s : mid, 0.011, along ? mid : s);
      st.receiveShadow = true;
      scene.add(st);
    }
  }
  const lampGeo = keep(new THREE.SphereGeometry(0.07, 8, 6));
  const lampMat = keep(new THREE.MeshBasicMaterial({ color: theme.lamp }));
  const postGeo = keep(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6));
  const postMat = keep(new THREE.MeshStandardMaterial({ color: theme.crane }));
  for (const x0 of lines) {
    for (const z0 of lines) {
      const x = x0 + 0.34;
      const z = z0 + 0.34;
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, 0.25, z);
      scene.add(post);
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(x, 0.52, z);
      scene.add(lamp);
    }
  }

  // Buildings: floors stacked lobby-up, each as wide as its rooms need.
  const wallMat = keep(new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.75, metalness: 0.08 }));
  const hoverMat = keep(new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.75, metalness: 0.08, emissive: "#6a62ea", emissiveIntensity: 0.35 }));
  const roofMat = keep(new THREE.MeshStandardMaterial({ color: theme.roof, roughness: 0.8 }));
  const ledgeMat = keep(new THREE.MeshStandardMaterial({ color: theme.roof, roughness: 0.6, metalness: 0.2 }));
  const planMat = keep(new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.9, transparent: true, opacity: 0.45 }));
  const bodies: THREE.Mesh[] = [];
  const from = rangeStart(range, now);
  const todayStart = startOfToday(now);
  type Slot = { m: THREE.Matrix4; room: Room; key: string; floor: string };
  const dark: Slot[] = [];
  const lit: Slot[] = [];
  const fresh: Slot[] = [];
  const labels: CSS2DObject[] = [];
  let tallest = 1;
  let tallestKey = "";
  const tmp = new THREE.Object3D();

  for (const b of city.buildings) {
    const H = heightOf(b);
    if (H > tallest) {
      tallest = H;
      tallestKey = b.key;
    }
    const cx = b.gx * LOT;
    const cz = b.gy * LOT;
    if (b.planned) {
      const geo = keep(new THREE.BoxGeometry(1.6, H, 1.6));
      const lot = new THREE.Mesh(geo, planMat);
      lot.position.set(cx, H / 2, cz);
      lot.userData.key = b.key;
      lot.userData.floor = "Planned";
      scene.add(lot);
      bodies.push(lot);
      addCrane(scene, cx, H, cz, theme, keep);
    } else {
      let y = 0;
      b.floors.forEach((f, fi) => {
        const h = f.levels * FLOOR;
        const geo = keep(new THREE.BoxGeometry(f.size, h, f.size));
        const body = new THREE.Mesh(geo, [wallMat, wallMat, fi === b.floors.length - 1 ? roofMat : wallMat, wallMat, wallMat, wallMat]);
        body.position.set(cx, y + h / 2, cz);
        body.castShadow = true;
        body.receiveShadow = true;
        body.userData.key = b.key;
        body.userData.floor = b.key ? f.label : MAIN_STREET;
        scene.add(body);
        bodies.push(body);
        // A thin ledge where a floor steps in from the one below.
        if (fi > 0 && b.floors[fi - 1].size > f.size + 0.01) {
          const ledge = new THREE.Mesh(keep(new THREE.BoxGeometry(b.floors[fi - 1].size + 0.04, 0.04, b.floors[fi - 1].size + 0.04)), ledgeMat);
          ledge.position.set(cx, y + 0.02, cz);
          scene.add(ledge);
        }
        placeRooms(f, cx, cz, y, tmp, (m, room) => {
          const slot = { m, room, key: b.key, floor: b.key ? f.label : MAIN_STREET };
          if (!room.lit) dark.push(slot);
          else {
            const t = Date.parse(room.at ?? "");
            const isFresh = range === "all" ? t >= todayStart : t >= from;
            (isFresh ? fresh : lit).push(slot);
          }
        });
        y += h;
      });
      // A slim parapet on the roof.
      const top = b.floors[b.floors.length - 1];
      const cap = new THREE.Mesh(keep(new THREE.BoxGeometry(top.size * 0.55, FLOOR * 0.35, top.size * 0.55)), roofMat);
      cap.position.set(cx, H - FLOOR * 0.6 + FLOOR * 0.17, cz);
      cap.castShadow = true;
      scene.add(cap);
      if (b.finished) addBeacon(scene, cx, H - FLOOR * 0.6, cz, theme, keep);
      if (b.today.length) addBillboard(scene, b, cx, H - FLOOR * 0.6, cz, top.size, theme, keep);
    }
    if (opts.labels) {
      const el = document.createElement("div");
      el.className = "city3d-label";
      el.dataset.key = b.key;
      el.textContent = b.name;
      const label = new CSS2DObject(el);
      label.position.set(cx, H + (b.today.length ? 1.25 : b.finished ? 1.0 : b.planned ? 1.6 : 0.45), cz);
      label.center.set(0.5, 1);
      scene.add(label);
      labels.push(label);
    }
  }

  // Rooms as instanced windows: dark (open), lit earlier, and lit recently (glowing).
  const winGeo = keep(new THREE.PlaneGeometry(1, 1));
  const windowMeshes: Built["windowMeshes"] = [];
  const instanced = (slots: Slot[], mat: THREE.Material) => {
    if (!slots.length) return;
    const mesh = new THREE.InstancedMesh(winGeo, mat, slots.length);
    slots.forEach((s, i) => mesh.setMatrixAt(i, s.m));
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    windowMeshes.push({ mesh, rooms: slots.map((s) => ({ room: s.room, key: s.key, floor: s.floor })) });
  };
  instanced(dark, keep(new THREE.MeshStandardMaterial({ color: theme.dark, roughness: 0.35, metalness: 0.4 })));
  instanced(lit, keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.lit).multiplyScalar(0.95), fog: true })));
  instanced(fresh, keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.fresh).multiplyScalar(1.6), toneMapped: false })));

  // The mayor, by Main Street.
  const main = city.buildings.find((b) => b.key === "");
  if (main) addMayor(scene, main, opts.mayor ?? null, opts.labels, keep, labels);
  addGreenery(scene, city, main?.key ?? null, keep);

  // Traffic: cars on every street, trucks round buildings going up, and
  // a few luxury cars round the tallest tower.
  const traffic = opts.still ? null : addTraffic(scene, city, lines, g0, g1, tallestKey, keep);

  // Shadows cover the city.
  const r = Math.max(span, tallest) * 0.8 + 4;
  moon.shadow.camera.left = -r;
  moon.shadow.camera.right = r;
  moon.shadow.camera.top = r;
  moon.shadow.camera.bottom = -r;
  moon.shadow.camera.far = 120;
  moon.target.position.set(mid, 0, mid);
  scene.add(moon, moon.target);

  const center = new THREE.Vector3(mid, Math.min(tallest * 0.3, 3), mid);
  const radius = Math.max(span * 0.75, tallest * 0.9, 6);
  const setHover = (key: string | null) => {
    for (const body of bodies) {
      const b = city.buildings.find((x) => x.key === body.userData.key);
      if (!b || b.planned) continue;
      const mats = body.material as THREE.Material[];
      const side = body.userData.key === key ? hoverMat : wallMat;
      body.material = [side, side, mats[2] === roofMat ? roofMat : side, side, side, side];
    }
    for (const l of labels) l.element.classList.toggle("on", l.element.dataset.key === key);
  };
  return {
    scene,
    setHover,
    bodies,
    windowMeshes,
    labels,
    radius,
    center,
    tick: (dt) => traffic?.(dt) ?? false,
    dispose: () => {
      for (const d of disposables) d.dispose();
      for (const l of labels) l.element.remove();
    },
  };
}

/** Rooms round a floor, storey by storey; every slot used is a window. */
function placeRooms(f: Floor, cx: number, cz: number, y0: number, tmp: THREE.Object3D, put: (m: THREE.Matrix4, room: Room) => void) {
  const half = f.size / 2;
  const cell = (f.size - 0.12) / f.per;
  f.rooms.forEach((room, i) => {
    const { level, side, slot } = roomSpot(f, i);
    const [nx, nz] = SIDES[side];
    const tx = -nz;
    const tz = nx;
    const u = -half + 0.06 + (slot + 0.5) * cell;
    const y = y0 + level * FLOOR + FLOOR * 0.5;
    tmp.position.set(cx + nx * (half + 0.004) + tx * u, y, cz + nz * (half + 0.004) + tz * u);
    tmp.rotation.set(0, Math.atan2(nx, nz), 0);
    tmp.scale.set(cell * 0.62, FLOOR * 0.52, 1);
    tmp.updateMatrix();
    put(tmp.matrix.clone(), room);
  });
}

/** Today's timed rooms on a billboard on the roof, in time order. */
function addBillboard(scene: THREE.Scene, b: Building, x: number, h: number, z: number, size: number, theme: SceneTheme, keep: Keep) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#11131c";
  ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = "#a29bff";
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, 504, 248);
  ctx.fillStyle = "#a29bff";
  ctx.font = "700 30px -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif";
  ctx.fillText("TODAY", 26, 48);
  ctx.font = "600 26px -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
  const rows = b.today.slice(0, 4);
  rows.forEach((r, i) => {
    const y = 96 + i * 44;
    ctx.fillStyle = "#ffd27a";
    ctx.fillText(timeText(r.time), 26, y);
    ctx.fillStyle = "#f2f1ee";
    let t = r.title;
    while (ctx.measureText(t).width > 330 && t.length > 4) t = `${t.slice(0, -2).trimEnd()}…`;
    ctx.fillText(t, 160, y);
  });
  if (b.today.length > 4) {
    ctx.fillStyle = "#9aa0a6";
    ctx.font = "500 22px -apple-system, system-ui, sans-serif";
    ctx.fillText(`+${b.today.length - 4} more`, 400, 48);
  }
  const tex = keep(new THREE.CanvasTexture(c));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const w = Math.max(0.9, Math.min(1.4, size * 0.9));
  const panel = new THREE.Mesh(keep(new THREE.PlaneGeometry(w, w / 2)), keep(new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false })));
  const group = new THREE.Group();
  panel.position.set(0, 0.55 + w / 4, 0);
  group.add(panel);
  const legMat = keep(new THREE.MeshStandardMaterial({ color: theme.crane, metalness: 0.5, roughness: 0.4 }));
  for (const lx of [-w / 3, w / 3]) {
    const leg = new THREE.Mesh(keep(new THREE.BoxGeometry(0.05, 0.6, 0.05)), legMat);
    leg.position.set(lx, 0.3, 0);
    group.add(leg);
  }
  group.position.set(x, h, z);
  // Face the usual viewing direction (south-east).
  group.rotation.y = 0.78;
  scene.add(group);
}

function timeText(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The mayor: a small figure in a dark suit with a purple sash and a top hat. */
function addMayor(scene: THREE.Scene, main: Building, name: string | null, label: boolean, keep: Keep, labels: CSS2DObject[]) {
  const size = main.floors[0]?.size ?? 1;
  const off = Math.min(size / 2 + 0.18, LOT / 2 - 0.32);
  const x = main.gx * LOT + off;
  const z = main.gy * LOT + off;
  const g = new THREE.Group();
  const suit = keep(new THREE.MeshStandardMaterial({ color: "#1d2033", roughness: 0.6 }));
  const skin = keep(new THREE.MeshStandardMaterial({ color: "#e0b48f", roughness: 0.7 }));
  const sash = keep(new THREE.MeshStandardMaterial({ color: "#a29bff", emissive: "#5249d9", emissiveIntensity: 0.4 }));
  const gold = keep(new THREE.MeshStandardMaterial({ color: "#ffd27a", metalness: 0.8, roughness: 0.3 }));
  const podium = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.16, 0.18, 0.06, 20)), gold);
  podium.position.y = 0.03;
  const legs = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.035, 0.04, 0.16, 10)), suit);
  legs.position.y = 0.14;
  const body = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.055, 0.07, 0.18, 14)), suit);
  body.position.y = 0.3;
  const band = new THREE.Mesh(keep(new THREE.TorusGeometry(0.062, 0.012, 6, 18)), sash);
  band.position.y = 0.31;
  band.rotation.set(Math.PI / 2.6, 0, 0.5);
  const head = new THREE.Mesh(keep(new THREE.SphereGeometry(0.05, 16, 12)), skin);
  head.position.y = 0.44;
  const brim = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.07, 0.07, 0.01, 18)), suit);
  brim.position.y = 0.48;
  const hat = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.042, 0.045, 0.09, 18)), suit);
  hat.position.y = 0.53;
  const hatBand = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.046, 0.046, 0.018, 18)), sash);
  hatBand.position.y = 0.5;
  for (const m of [podium, legs, body, head, hat]) m.castShadow = true;
  g.add(podium, legs, body, band, head, brim, hat, hatBand);
  g.position.set(x, 0.02, z);
  g.rotation.y = 0.78;
  g.scale.setScalar(1.4);
  scene.add(g);
  if (label) {
    const el = document.createElement("div");
    el.className = "city3d-label mayor";
    el.textContent = name ? `Mayor ${name}` : "The mayor";
    const l = new CSS2DObject(el);
    l.position.set(x, 1.05, z);
    l.center.set(0.5, 1);
    scene.add(l);
    labels.push(l);
  }
}

type Vehicle = { obj: THREE.Object3D; path: THREE.Vector3[]; length: number; t: number; speed: number };

/** Cars, trucks and luxury cars, each driving its own loop. */
/**
 * A few trees and bushes on the pavements between the buildings and the
 * streets — two or three per block, never crowding a building or the mayor.
 */
function addGreenery(scene: THREE.Scene, city: City, mayorKey: string | null, keep: Keep) {
  let seed = 23;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const trees: [number, number, number][] = [];
  const bushes: [number, number, number][] = [];
  const edge = LOT / 2 - 0.42;
  for (const b of city.buildings) {
    const half = (b.floors[0]?.size ?? 0.6) / 2;
    if (half + 0.2 > edge) continue; // No room on this block.
    const cx = b.gx * LOT;
    const cz = b.gy * LOT;
    const spots: [number, number][] = [];
    for (let side = 0; side < 4; side++) {
      for (const t of [-0.62, 0, 0.62]) {
        const a = t * edge;
        const [x, z] = side === 0 ? [a, -edge] : side === 1 ? [edge, a] : side === 2 ? [a, edge] : [-edge, a];
        // The mayor stands on Main Street's south-east corner.
        if (b.key === mayorKey && x > 0.3 && z > 0.3) continue;
        spots.push([cx + x, cz + z]);
      }
    }
    // Shuffle, then take a couple of trees and a bush or two.
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const nT = 1 + Math.floor(rnd() * 2);
    const nB = 1 + Math.floor(rnd() * 2);
    spots.slice(0, nT).forEach(([x, z]) => trees.push([x, z, 0.85 + rnd() * 0.35]));
    spots.slice(nT, nT + nB).forEach(([x, z]) => bushes.push([x, z, 0.8 + rnd() * 0.4]));
  }
  const tmp = new THREE.Object3D();
  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, items: [number, number, number][], y: (s: number) => number, sy = 1) => {
    if (!items.length) return;
    const m = new THREE.InstancedMesh(keep(geo), keep(mat), items.length);
    items.forEach(([x, z, s], i) => {
      tmp.position.set(x, y(s), z);
      tmp.rotation.set(0, rnd() * Math.PI, 0);
      tmp.scale.set(s, s * sy, s);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  };
  instanced(new THREE.CylinderGeometry(0.022, 0.03, 0.2, 6), new THREE.MeshStandardMaterial({ color: "#6e4f38", roughness: 0.9 }), trees, (s) => 0.1 * s);
  instanced(new THREE.IcosahedronGeometry(0.15, 0), new THREE.MeshStandardMaterial({ color: "#3f8a5a", roughness: 0.85, flatShading: true }), trees, (s) => 0.3 * s, 1.15);
  instanced(new THREE.IcosahedronGeometry(0.085, 0), new THREE.MeshStandardMaterial({ color: "#4f9a5e", roughness: 0.9, flatShading: true }), bushes, (s) => 0.055 * s, 0.7);
}

function addTraffic(scene: THREE.Scene, city: City, lines: number[], g0: number, g1: number, tallestKey: string, keep: Keep): ((dt: number) => boolean) | null {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const vehicles: Vehicle[] = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Soft, dim lamps: enough to tell which way a car is going, no glare.
  const headMat = keep(new THREE.MeshBasicMaterial({ color: "#b9b09a" }));
  const tailMat = keep(new THREE.MeshBasicMaterial({ color: "#8f3a33" }));
  const glassMat = keep(new THREE.MeshStandardMaterial({ color: "#1b2233", metalness: 0.6, roughness: 0.2 }));

  const make = (kind: "car" | "truck" | "luxury", color: string) => {
    const g = new THREE.Group();
    const paint = keep(new THREE.MeshStandardMaterial({ color, metalness: kind === "luxury" ? 0.9 : 0.4, roughness: kind === "luxury" ? 0.15 : 0.45 }));
    const L = kind === "truck" ? 0.42 : kind === "luxury" ? 0.36 : 0.28;
    const W = kind === "truck" ? 0.16 : 0.14;
    const H = kind === "truck" ? 0.16 : kind === "luxury" ? 0.06 : 0.08;
    const body = new THREE.Mesh(keep(new THREE.BoxGeometry(L, H, W)), paint);
    body.position.y = H / 2 + 0.03;
    body.castShadow = true;
    g.add(body);
    if (kind === "truck") {
      const cab = new THREE.Mesh(keep(new THREE.BoxGeometry(0.12, 0.13, W)), keep(new THREE.MeshStandardMaterial({ color: "#f2b632", roughness: 0.5 })));
      cab.position.set(L / 2 + 0.06, 0.1, 0);
      g.add(cab);
      const bed = new THREE.Mesh(keep(new THREE.BoxGeometry(L * 0.8, 0.05, W * 0.9)), keep(new THREE.MeshStandardMaterial({ color: "#8a6a4a" })));
      bed.position.set(-0.02, H + 0.055, 0);
      g.add(bed);
    } else {
      const cabin = new THREE.Mesh(keep(new THREE.BoxGeometry(L * (kind === "luxury" ? 0.45 : 0.55), kind === "luxury" ? 0.05 : 0.06, W * 0.86)), glassMat);
      cabin.position.set(kind === "luxury" ? -0.03 : -0.02, H + 0.055, 0);
      g.add(cabin);
    }
    const front = kind === "truck" ? L / 2 + 0.12 : L / 2;
    for (const s of [-1, 1]) {
      const hl = new THREE.Mesh(keep(new THREE.BoxGeometry(0.012, 0.022, 0.03)), headMat);
      hl.position.set(front + 0.006, 0.07, s * (W / 2 - 0.025));
      const tl = new THREE.Mesh(keep(new THREE.BoxGeometry(0.012, 0.02, 0.03)), tailMat);
      tl.position.set(-L / 2 - 0.006, 0.07, s * (W / 2 - 0.025));
      g.add(hl, tl);
    }
    g.scale.setScalar(1.5);
    scene.add(g);
    return g;
  };
  const loop = (pts: [number, number][]) => pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const add = (obj: THREE.Object3D, path: THREE.Vector3[], speed: number) => {
    let length = 0;
    for (let i = 0; i < path.length; i++) length += path[i].distanceTo(path[(i + 1) % path.length]);
    vehicles.push({ obj, path, length, t: rnd() * length, speed });
  };
  // A lane round a lot's four streets (clockwise), kept to its inner side.
  const around = (gx: number, gy: number, inset: number) => {
    const cx = gx * LOT;
    const cz = gy * LOT;
    const h = LOT / 2 - inset;
    return loop([
      [cx - h, cz - h],
      [cx + h, cz - h],
      [cx + h, cz + h],
      [cx - h, cz + h],
    ]);
  };

  // Everyday cars on the grid: straight runs across the city, both ways.
  const colors = ["#d94f4f", "#3f7fd9", "#e8e4dc", "#3a3d48", "#4caf7a", "#d9a441", "#7a5cd6"];
  const runs = Math.min(18, lines.length * 3);
  for (let i = 0; i < runs; i++) {
    const s = lines[Math.floor(rnd() * lines.length)];
    const dir = rnd() < 0.5 ? 1 : -1;
    const lane = 0.1 * dir;
    const alongX = rnd() < 0.5;
    const a = g0 - 0.2;
    const b = g1 + 0.2;
    const path = alongX
      ? loop([
          [dir > 0 ? a : b, s + lane],
          [dir > 0 ? b : a, s + lane],
        ])
      : loop([
          [s - lane, dir > 0 ? a : b],
          [s - lane, dir > 0 ? b : a],
        ]);
    add(make("car", colors[i % colors.length]), path, 0.7 + rnd() * 0.5);
  }
  // Trucks round buildings under construction.
  for (const b of city.buildings) {
    if (!(b.planned || b.building)) continue;
    add(make("truck", "#f2b632"), around(b.gx, b.gy, 0.1), 0.45);
    if (b.planned) add(make("truck", "#e07b39"), around(b.gx, b.gy, 0.1), 0.4);
  }
  // Luxury cars round the tallest tower.
  const top = city.buildings.find((b) => b.key === tallestKey);
  if (top && !top.planned) {
    for (const c of ["#111216", "#c9a24a", "#e9e6df"]) add(make("luxury", c), around(top.gx, top.gy, 0.1), 0.8);
  }
  if (!vehicles.length) return null;

  const place = (v: Vehicle) => {
    let d = v.t % v.length;
    if (v.path.length === 2) {
      // A straight run across the city: back to the start at the end.
      const [p, q] = v.path;
      const k = d / v.length;
      v.obj.position.set(p.x + (q.x - p.x) * k, 0.012, p.z + (q.z - p.z) * k);
      v.obj.rotation.y = -Math.atan2(q.z - p.z, q.x - p.x);
      return;
    }
    for (let i = 0; i < v.path.length; i++) {
      const p = v.path[i];
      const q = v.path[(i + 1) % v.path.length];
      const seg = p.distanceTo(q);
      if (d <= seg) {
        const k = seg ? d / seg : 0;
        v.obj.position.set(p.x + (q.x - p.x) * k, 0.012, p.z + (q.z - p.z) * k);
        v.obj.rotation.y = -Math.atan2(q.z - p.z, q.x - p.x);
        return;
      }
      d -= seg;
    }
  };
  for (const v of vehicles) {
    if (v.path.length === 2) v.length = v.path[0].distanceTo(v.path[1]);
    place(v);
  }
  return (dt: number) => {
    for (const v of vehicles) {
      v.t += v.speed * dt;
      place(v);
    }
    return true;
  };
}

function addBeacon(scene: THREE.Scene, x: number, h: number, z: number, theme: SceneTheme, keep: <T extends { dispose: () => void }>(x: T) => T) {
  const mast = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6)), keep(new THREE.MeshStandardMaterial({ color: theme.crane })));
  mast.position.set(x, h + 0.35, z);
  scene.add(mast);
  const light = new THREE.Mesh(keep(new THREE.SphereGeometry(0.11, 16, 12)), keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.beacon).multiplyScalar(2), toneMapped: false })));
  light.position.set(x, h + 0.75, z);
  scene.add(light);
}

function addCrane(scene: THREE.Scene, x: number, h: number, z: number, theme: SceneTheme, keep: <T extends { dispose: () => void }>(x: T) => T) {
  const mat = keep(new THREE.MeshStandardMaterial({ color: theme.crane, metalness: 0.4, roughness: 0.5 }));
  const mast = new THREE.Mesh(keep(new THREE.BoxGeometry(0.06, 1.5, 0.06)), mat);
  mast.position.set(x, h + 0.75, z);
  const jib = new THREE.Mesh(keep(new THREE.BoxGeometry(1.4, 0.05, 0.05)), mat);
  jib.position.set(x + 0.3, h + 1.45, z);
  const cable = new THREE.Mesh(keep(new THREE.BoxGeometry(0.012, 0.55, 0.012)), mat);
  cable.position.set(x + 0.85, h + 1.18, z);
  scene.add(mast, jib, cable);
}

/** A first look at the city: from the south-east, a little above. */
function homeCamera(camera: THREE.PerspectiveCamera, built: Built, zoom = 1) {
  const d = (built.radius * 2.6) / zoom;
  const yaw = 0.78;
  const pitch = 0.62;
  camera.position.set(
    built.center.x + d * Math.cos(pitch) * Math.sin(yaw),
    built.center.y + d * Math.sin(pitch),
    built.center.z + d * Math.cos(pitch) * Math.cos(yaw),
  );
  camera.lookAt(built.center);
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * The live city. `still` renders a single frame (the corner card); otherwise
 * it can be turned, zoomed and clicked.
 */
export function CityScene({
  city,
  range,
  now,
  dark,
  still,
  labels,
  mayor,
  onPick,
  onHover,
  onInteract,
}: {
  city: City;
  range: CityRange;
  now: Date;
  dark: boolean;
  still?: boolean;
  labels?: boolean;
  /** The mayor's name, shown by their figure. */
  mayor?: string | null;
  onPick?: (key: string) => void;
  onHover?: (p: Picked | null) => void;
  onInteract?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onPick, onHover, onInteract });
  cb.current = { onPick, onHover, onInteract };
  // Swap in a new city without rebuilding the renderer (set by the effect below).
  const setCity = useRef<((city: City, range: CityRange, now: Date) => void) | null>(null);
  const latest = useRef({ city, range, now, mayor });
  latest.current = { city, range, now, mayor };
  const day = now.toDateString();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const theme = dark ? NIGHT_3D : DUSK_3D;
    const first = latest.current;
    let built = buildScene(first.city, theme, first.range, first.now, { labels: !!labels, mayor: first.mayor, still: !!still });
    let hoverKey: string | null = null;
    let flyTo: { from: THREE.Vector3; to: THREE.Vector3; start: number; key: string } | null = null;
    let dirty = true;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: !!still });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = dark ? 1.05 : 1.15;
    renderer.domElement.className = still ? "city3d-canvas" : "city3d-canvas live";
    el.appendChild(renderer.domElement);
    const labelRenderer = labels ? new CSS2DRenderer() : null;
    if (labelRenderer) {
      labelRenderer.domElement.className = "city3d-labels";
      el.appendChild(labelRenderer.domElement);
    }

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
    homeCamera(camera, built, still ? 1.6 : 1);
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(built.scene, camera);
    composer.addPass(renderPass);
    const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), theme.bloom, 0.55, 0.82);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    let controls: OrbitControls | null = null;
    if (!still) {
      const c = new OrbitControls(camera, renderer.domElement);
      controls = c;
      c.target.copy(built.center);
      c.enableDamping = true;
      c.dampingFactor = 0.08;
      c.minPolarAngle = 0.15;
      c.maxPolarAngle = 1.38;
      c.minDistance = built.radius * 0.6;
      c.maxDistance = built.radius * 5;
      c.screenSpacePanning = false;
      c.autoRotate = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      c.autoRotateSpeed = 0.35;
      c.update();
      c.addEventListener("start", () => {
        if (c.autoRotate) {
          c.autoRotate = false;
          cb.current.onInteract?.();
        }
      });
    }

    const draw = () => {
      composer.render();
      if (labelRenderer) labelRenderer.render(built.scene, camera);
      dirty = false;
    };
    const size = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      composer.setSize(w, h);
      bloom.resolution.set(w, h);
      labelRenderer?.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
      if (still) draw();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    setCity.current = (c, r, n) => {
      const old = built;
      built = buildScene(c, theme, r, n, { labels: !!labels, mayor: latest.current.mayor, still: !!still });
      renderPass.scene = built.scene;
      built.setHover(hoverKey);
      old.dispose();
      if (controls) {
        controls.minDistance = built.radius * 0.6;
        controls.maxDistance = built.radius * 5;
      }
      dirty = true;
      if (still) draw();
    };

    // Picking: the nearest building, and the lit window under the pointer.
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pickAt = (clientX: number, clientY: number): Picked | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hitB = ray.intersectObjects(built.bodies, false)[0];
      let best: { d: number; room: Room; key: string; floor: string } | null = null;
      for (const wm of built.windowMeshes) {
        const h = ray.intersectObject(wm.mesh, false)[0];
        if (h && h.instanceId !== undefined && (!best || h.distance < best.d)) best = { d: h.distance, ...wm.rooms[h.instanceId] };
      }
      const x = clientX - r.left;
      const y = clientY - r.top;
      if (best && (!hitB || best.d <= hitB.distance + 0.05)) return { key: best.key, room: best.room, floor: best.floor, x, y };
      if (hitB) return { key: hitB.object.userData.key as string, room: null, floor: (hitB.object.userData.floor as string) ?? null, x, y };
      return null;
    };

    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent) => {
      if (down && (e.buttons & 1) !== 0) return;
      const p = pickAt(e.clientX, e.clientY);
      const key = p?.key ?? null;
      if (key !== hoverKey) {
        hoverKey = key;
        built.setHover(key);
        dirty = true;
      }
      renderer.domElement.style.cursor = p ? "pointer" : "grab";
      cb.current.onHover?.(p);
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const p = pickAt(e.clientX, e.clientY);
      if (!p) return;
      // Glide toward the building, then open its project.
      const body = built.bodies.find((m) => m.userData.key === p.key);
      if (body && controls) {
        controls.autoRotate = false;
        flyTo = { from: controls.target.clone(), to: body.position.clone(), start: performance.now(), key: p.key };
      } else cb.current.onPick?.(p.key);
    };
    const onLeave = () => {
      if (hoverKey !== null) {
        hoverKey = null;
        built.setHover(null);
        dirty = true;
      }
      cb.current.onHover?.(null);
    };
    const goHome = () => {
      if (!controls) return;
      homeCamera(camera, built);
      controls.target.copy(built.center);
      controls.update();
    };
    // Keys: arrows turn and tilt, + and - zoom, 0 goes back to the first view.
    const onKey = (e: KeyboardEvent) => {
      if (!controls) return;
      const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      let used = true;
      if (e.key === "ArrowLeft") sph.theta -= Math.PI / 12;
      else if (e.key === "ArrowRight") sph.theta += Math.PI / 12;
      else if (e.key === "ArrowUp") sph.phi = Math.max(controls.minPolarAngle, sph.phi - 0.1);
      else if (e.key === "ArrowDown") sph.phi = Math.min(controls.maxPolarAngle, sph.phi + 0.1);
      else if (e.key === "+" || e.key === "=") sph.radius = Math.max(controls.minDistance, sph.radius / 1.2);
      else if (e.key === "-") sph.radius = Math.min(controls.maxDistance, sph.radius * 1.2);
      else if (e.key === "0") {
        e.preventDefault();
        goHome();
        return;
      } else used = false;
      if (!used) return;
      e.preventDefault();
      e.stopPropagation();
      controls.autoRotate = false;
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
      controls.update();
    };
    const canvas = renderer.domElement;
    if (!still) {
      canvas.tabIndex = 0;
      canvas.setAttribute("aria-label", "Your city in 3D. Drag or use the arrow keys to turn it, plus and minus to zoom, 0 to reset.");
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointerleave", onLeave);
      canvas.addEventListener("dblclick", goHome);
      canvas.addEventListener("keydown", onKey);
      controls?.addEventListener("change", () => {
        dirty = true;
      });
    }

    // Draw only when something changed (turning, hovering, a new window).
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      if (built.tick(dt)) dirty = true;
      if (flyTo && controls) {
        const k = Math.min(1, (t - flyTo.start) / 450);
        const ease = 1 - Math.pow(1 - k, 3);
        controls.target.lerpVectors(flyTo.from, flyTo.to, ease);
        const dir = camera.position.clone().sub(controls.target);
        dir.setLength(Math.max(controls.minDistance, dir.length() * (1 - 0.05 * ease)));
        camera.position.copy(controls.target).add(dir);
        dirty = true;
        if (k >= 1) {
          const key = flyTo.key;
          flyTo = null;
          cb.current.onPick?.(key);
        }
      }
      controls?.update();
      if (dirty) draw();
      raf = requestAnimationFrame(loop);
    };
    if (!still) raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      setCity.current = null;
      controls?.dispose();
      canvas.removeEventListener("keydown", onKey);
      built.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      el.innerHTML = "";
    };
  }, [dark, still, labels]);

  // A finished task (or a new day, or another range) re-lays the city in place.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const { city: c, range: r, now: n } = latest.current;
    setCity.current?.(c, r, n);
  }, [city, range, day, mayor]);

  return <div ref={host} className="city3d" />;
}

/** The share picture: the city from a good angle, with its name and count. */
export function renderCityPicture(city: City, name: string, opts: { count: number | null; names: boolean; now: Date; dark: boolean }): HTMLCanvasElement {
  const W = 1200;
  const H = 630;
  const theme = opts.dark ? NIGHT_3D : DUSK_3D;
  const built = buildScene(city, theme, "week", opts.now, { labels: false, still: true });
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 500);
  homeCamera(camera, built, 1.15);
  // Leave room for the name at the top left.
  camera.position.y += built.radius * 0.15;
  camera.lookAt(built.center.clone().add(new THREE.Vector3(0, -built.radius * 0.12, 0)));
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(built.scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), theme.bloom, 0.55, 0.82));
  composer.addPass(new OutputPass());
  composer.setSize(W, H);
  composer.render();

  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(renderer.domElement, 0, 0, W, H);
  if (opts.names) {
    ctx.font = '600 15px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
    ctx.textAlign = "center";
    for (const b of city.buildings) {
      const top = new THREE.Vector3(b.gx * LOT, heightOf(b) + 0.6, b.gy * LOT).project(camera);
      const x = (top.x * 0.5 + 0.5) * W;
      const y = (-top.y * 0.5 + 0.5) * H;
      const tw = ctx.measureText(b.name).width + 18;
      ctx.fillStyle = opts.dark ? "rgba(13,14,20,0.8)" : "rgba(255,255,255,0.85)";
      const rx = x - tw / 2;
      const ry = y - 24;
      ctx.beginPath();
      ctx.moveTo(rx + 11, ry);
      ctx.arcTo(rx + tw, ry, rx + tw, ry + 22, 11);
      ctx.arcTo(rx + tw, ry + 22, rx, ry + 22, 11);
      ctx.arcTo(rx, ry + 22, rx, ry, 11);
      ctx.arcTo(rx, ry, rx + tw, ry, 11);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = opts.dark ? "#d6d8e6" : "#3d2f35";
      ctx.fillText(b.name, x, y - 8);
    }
  }
  const ink = opts.dark ? "#ffffff" : "#2d2226";
  const sub = opts.dark ? "rgba(214, 216, 230, 0.9)" : "rgba(61, 47, 53, 0.8)";
  ctx.textAlign = "left";
  ctx.fillStyle = ink;
  ctx.font = '750 46px -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
  ctx.fillText(name, 48, 84);
  if (opts.count !== null) {
    ctx.fillStyle = sub;
    ctx.font = '500 22px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
    ctx.fillText(`${opts.count} ${opts.count === 1 ? "thing" : "things"} done this week`, 48, 118);
  }
  ctx.textAlign = "right";
  ctx.fillStyle = sub;
  ctx.font = '600 17px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
  ctx.fillText("Built with Plucky", W - 32, H - 26);

  built.dispose();
  composer.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}
