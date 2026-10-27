import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FLOOR, HOUSES, HOUSES_PER_LOT, LOT, heightOf, rangeStart, roomSpot, startOfToday, type Building, type City, type CityRange, type Floor, type Room } from "../lib/city";
import { clockHour12 } from "../lib/schedule";
import { currentMayorLook, mayorFigure } from "../lib/mayorModel";
import { isUnlocked } from "../lib/milestones";

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
  house: string;
  houseRoof: string;
  plot: string;
  grass: string;
  water: string;
  stone: string;
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
  house: "#3b3550",
  houseRoof: "#5a3f4a",
  plot: "#2a2420",
  grass: "#18291f",
  water: "#0c1a2e",
  stone: "#454a66",
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
  house: "#c9a493",
  houseRoof: "#a2584a",
  plot: "#c8ab90",
  grass: "#9db487",
  water: "#7d9fbf",
  stone: "#d8c6b8",
};

export interface Picked {
  key: string;
  /** The home (task) under the pointer, lit or dark. */
  room: Room | null;
  /** Which floor it's on ("1st Floor: Travel"). */
  floor: string | null;
  /** Which house, for a task in no project (each house is one task). */
  house?: number;
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
  windowMeshes: { mesh: THREE.InstancedMesh; rooms: { room: Room; key: string; floor: string; house?: number }[] }[];
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
    for (const [x, y] of b.lots) {
      gMin = Math.min(gMin, x, y);
      gMax = Math.max(gMax, x, y);
    }
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
  // Street lamps come with the first milestone (population 10).
  const reached = city.reached ?? city.total;
  for (const x0 of isUnlocked("lamps", reached) ? lines : []) {
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
  const houseMat = keep(new THREE.MeshStandardMaterial({ color: theme.house, roughness: 0.8 }));
  const houseRoofMat = keep(new THREE.MeshStandardMaterial({ color: theme.houseRoof, roughness: 0.7, flatShading: true }));
  const plotMat = keep(new THREE.MeshStandardMaterial({ color: theme.plot, roughness: 1 }));
  const porchMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.fresh).multiplyScalar(1.4), toneMapped: false }));
  const houseGeo = keep(new THREE.BoxGeometry(0.62, 0.42, 0.56));
  const houseRoofGeo = keep(new THREE.ConeGeometry(0.5, 0.3, 4));
  const porchGeo = keep(new THREE.SphereGeometry(0.035, 8, 6));
  // Remember each body's own look, and its look under the pointer.
  const own = (body: THREE.Mesh, mats: THREE.Material[]) => {
    body.material = mats;
    body.userData.base = mats;
    body.userData.hover = mats.map((m) => (m === roofMat || m === houseRoofMat ? m : hoverMat));
  };
  const bodies: THREE.Mesh[] = [];
  const from = rangeStart(range, now);
  const todayStart = startOfToday(now);
  type Slot = { m: THREE.Matrix4; room: Room; key: string; floor: string; house?: number };
  const dark: Slot[] = [];
  const readying: Slot[] = [];
  const late: Slot[] = [];
  const lit: Slot[] = [];
  const fresh: Slot[] = [];
  const sort = (slot: Slot) => {
    const room = slot.room;
    if (!room.lit) {
      if (room.late) late.push(slot);
      else if (room.readying && room.readying.done > 0) readying.push(slot);
      else dark.push(slot);
      return;
    }
    const t = Date.parse(room.at ?? "");
    const isFresh = range === "all" ? t >= todayStart : t >= from;
    (isFresh ? fresh : lit).push(slot);
  };
  const labels: CSS2DObject[] = [];
  let tallest = 1;
  let tallestKey = "";
  const tmp = new THREE.Object3D();

  for (const b of city.buildings) {
    const H = heightOf(b);
    if (b.kind === "houses") {
      addHouses(b);
      continue;
    }
    if (b.kind === "plots") {
      addPlots(b);
      continue;
    }
    if (H > tallest) {
      tallest = H;
      tallestKey = b.key;
    }
    const cx = b.gx * LOT;
    const cz = b.gy * LOT;
    if (b.planned) {
      const geo = keep(new THREE.BoxGeometry(1.6, H, 1.6));
      const lot = new THREE.Mesh(geo, planMat);
      own(lot, [planMat, planMat, planMat, planMat, planMat, planMat]);
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
        const body = new THREE.Mesh(geo);
        own(body, [wallMat, wallMat, fi === b.floors.length - 1 ? roofMat : wallMat, wallMat, wallMat, wallMat]);
        body.position.set(cx, y + h / 2, cz);
        body.castShadow = true;
        body.receiveShadow = true;
        body.userData.key = b.key;
        body.userData.floor = f.label;
        scene.add(body);
        bodies.push(body);
        // A thin ledge where a floor steps in from the one below.
        if (fi > 0 && b.floors[fi - 1].size > f.size + 0.01) {
          const ledge = new THREE.Mesh(keep(new THREE.BoxGeometry(b.floors[fi - 1].size + 0.04, 0.04, b.floors[fi - 1].size + 0.04)), ledgeMat);
          ledge.position.set(cx, y + 0.02, cz);
          scene.add(ledge);
        }
        placeRooms(f, cx, cz, y, tmp, (m, room) => sort({ m, room, key: b.key, floor: f.label }));
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
    addLabel(b, cx, H + (b.today.length ? 1.25 : b.finished ? 1.0 : b.planned ? 1.6 : 0.45), cz);
  }

  function addLabel(b: Building, x: number, y: number, z: number) {
    if (!opts.labels) return;
    const el = document.createElement("div");
    el.className = b.kind === "tower" ? "city3d-label" : `city3d-label ${b.kind}`;
    el.dataset.key = b.key;
    el.textContent = b.name;
    const label = new CSS2DObject(el);
    label.position.set(x, y, z);
    label.center.set(0.5, 1);
    scene.add(label);
    labels.push(label);
  }

  /** Tasks in no project: little houses, nine to a block, porch lights on once done. */
  function addHouses(b: Building) {
    const rooms = b.floors[0]?.rooms ?? [];
    rooms.forEach((room, i) => {
      const [gx, gy] = b.lots[Math.floor(i / HOUSES_PER_LOT)] ?? b.lots[b.lots.length - 1];
      const k = i % HOUSES_PER_LOT;
      const x = gx * LOT + ((k % 3) - 1) * 1.02;
      const z = gy * LOT + (Math.floor(k / 3) - 1) * 1.02;
      const body = new THREE.Mesh(houseGeo);
      own(body, [houseMat, houseMat, houseMat, houseMat, houseMat, houseMat]);
      body.position.set(x, 0.21, z);
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData.key = b.key;
      body.userData.floor = HOUSES;
      // Each house is one task: hovering it shows that task, and only it lights up.
      body.userData.room = room;
      body.userData.house = i;
      scene.add(body);
      bodies.push(body);
      const roof = new THREE.Mesh(houseRoofGeo, houseRoofMat);
      roof.position.set(x, 0.42 + 0.15, z);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(1, 1, 0.92);
      roof.castShadow = true;
      scene.add(roof);
      // The front faces the street: houses on the block's edges look out
      // at the road beside them; the one in the middle can face any way.
      const col = k % 3;
      const row = Math.floor(k / 3);
      const out: [number, number][] = [];
      if (col === 0) out.push([-1, 0]);
      if (col === 2) out.push([1, 0]);
      if (row === 0) out.push([0, -1]);
      if (row === 2) out.push([0, 1]);
      const [nx, nz] = out.length ? out[i % out.length] : SIDES[(i * 7 + 3) % 4];
      // Along the front (to the house's right, looking at it).
      const tx = nz;
      const tz = -nx;
      const half = nx ? 0.312 : 0.282;
      // One window on the front, and a porch light by the door once someone lives here.
      tmp.position.set(x + nx * half - tx * 0.12, 0.22, z + nz * half - tz * 0.12);
      tmp.rotation.set(0, Math.atan2(nx, nz), 0);
      tmp.scale.set(0.2, 0.16, 1);
      tmp.updateMatrix();
      sort({ m: tmp.matrix.clone(), room, key: b.key, floor: HOUSES, house: i });
      if (room.lit) {
        const porch = new THREE.Mesh(porchGeo, porchMat);
        porch.position.set(x + nx * (half + 0.02) + tx * 0.16, 0.3, z + nz * (half + 0.02) + tz * 0.16);
        scene.add(porch);
      }
    });
    const [gx, gy] = b.lots[0];
    addLabel(b, gx * LOT, 1.3, gy * LOT - 1.02);
  }

  /** Someday ideas: a cleared plot with a Coming soon sign for each (up to nine). */
  function addPlots(b: Building) {
    const [gx, gy] = b.lots[0];
    const cx = gx * LOT;
    const cz = gy * LOT;
    const ground = new THREE.Mesh(keep(new THREE.BoxGeometry(2.7, 0.05, 2.7)));
    own(ground, [plotMat, plotMat, plotMat, plotMat, plotMat, plotMat]);
    ground.position.set(cx, 0.025, cz);
    ground.receiveShadow = true;
    ground.userData.key = b.key;
    ground.userData.floor = `${city.comingSoon.length} ${city.comingSoon.length === 1 ? "idea" : "ideas"} for someday`;
    scene.add(ground);
    bodies.push(ground);
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f4efe3";
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = "#5249d9";
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, 246, 118);
    ctx.fillStyle = "#2a2850";
    ctx.font = "800 40px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("COMING", 128, 58);
    ctx.fillText("SOON", 128, 102);
    const tex = keep(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const boardMat = keep(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    const postMat = keep(new THREE.MeshStandardMaterial({ color: "#7a5a3c", roughness: 0.9 }));
    const boardGeo = keep(new THREE.BoxGeometry(0.46, 0.23, 0.02));
    const postGeo = keep(new THREE.BoxGeometry(0.03, 0.34, 0.03));
    const n = Math.min(9, city.comingSoon.length);
    for (let i = 0; i < n; i++) {
      const x = cx + ((i % 3) - 1) * 0.8;
      const z = cz + (Math.floor(i / 3) - 1) * 0.8;
      const sign = new THREE.Group();
      const board = new THREE.Mesh(boardGeo, boardMat);
      board.position.y = 0.36;
      board.castShadow = true;
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.y = 0.17;
      sign.add(board, post);
      sign.position.set(x, 0.05, z);
      sign.rotation.y = 0.78;
      scene.add(sign);
    }
    addLabel(b, cx, 1.1, cz);
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
    windowMeshes.push({ mesh, rooms: slots.map((s) => ({ room: s.room, key: s.key, floor: s.floor, house: s.house })) });
  };
  instanced(dark, keep(new THREE.MeshStandardMaterial({ color: theme.dark, roughness: 0.35, metalness: 0.4 })));
  // A home being readied (some sub-tasks done): a faint glow behind the curtains.
  instanced(readying, keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.lit).multiplyScalar(0.38) })));
  // Overdue: blinking amber, someone's waiting at the door.
  const lateMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color("#ff9a3d"), toneMapped: false }));
  const lateBase = new THREE.Color("#ff9a3d");
  instanced(late, lateMat);
  let blinkT = 0;
  instanced(lit, keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.lit).multiplyScalar(0.95), fog: true })));
  instanced(fresh, keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.fresh).multiplyScalar(1.6), toneMapped: false })));

  // The mayor, by the oldest building downtown.
  const main = city.buildings[0];
  if (main) addMayor(scene, main, opts.mayor ?? null, opts.labels, keep, labels);
  addGreenery(scene, city, main?.key ?? null, keep);

  // Milestones: the park, fountain, train, harbour, stadium and island.
  const grown = addMilestones(scene, reached, g0, g1, theme, keep, opts.labels ? labels : null, !!opts.still);

  // Traffic: cars on every street, trucks round buildings going up, and
  // a few luxury cars round the tallest tower.
  const traffic = opts.still ? null : addTraffic(scene, city, lines, g0, g1, tallestKey, keep);

  // Shadows cover the city (and what's grown round it).
  const r = Math.max(span, tallest, grown.extent * 1.2) * 0.8 + 4;
  moon.shadow.camera.left = -r;
  moon.shadow.camera.right = r;
  moon.shadow.camera.top = r;
  moon.shadow.camera.bottom = -r;
  moon.shadow.camera.far = 120;
  moon.target.position.set(mid, 0, mid);
  scene.add(moon, moon.target);

  // Frame the city and everything grown round it.
  const [bx0, bx1, bz0, bz1] = grown.bounds;
  const center = new THREE.Vector3((bx0 + bx1) / 2, Math.min(tallest * 0.3, 3), (bz0 + bz1) / 2);
  const radius = Math.max(span * 0.75, tallest * 0.9, Math.hypot(bx1 - bx0, bz1 - bz0) * 0.42, 6);
  // `key` is a building's key, or "key#n" for one house.
  const setHover = (key: string | null) => {
    for (const body of bodies) {
      const on = body.userData.house !== undefined ? key === `${body.userData.key}#${body.userData.house}` : body.userData.key === key;
      body.material = on ? body.userData.hover : body.userData.base;
    }
    const building = key?.split("#")[0] ?? null;
    for (const l of labels) l.element.classList.toggle("on", l.element.dataset.key === building);
  };
  return {
    scene,
    setHover,
    bodies,
    windowMeshes,
    labels,
    radius,
    center,
    tick: (dt) => {
      const grew = grown.tick?.(dt) ?? false;
      const moved = (traffic?.(dt) ?? false) || grew;
      if (!late.length || document.documentElement.dataset.cityMotion === "off") return moved;
      blinkT += dt;
      lateMat.color.copy(lateBase).multiplyScalar(0.35 + 0.85 * (0.5 + 0.5 * Math.sin(blinkT * 4)));
      return true;
    },
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

/** "Moving in today": today's timed tasks on a billboard on the roof, in time order. */
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
  ctx.fillText("MOVING IN TODAY", 26, 48);
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
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: clockHour12() });
}

/** The mayor (a man or a woman, as picked in Settings) on a small gold podium. */
function addMayor(scene: THREE.Scene, main: Building, name: string | null, label: boolean, keep: Keep, labels: CSS2DObject[]) {
  const size = main.floors[0]?.size ?? 1;
  const off = Math.min(size / 2 + 0.18, LOT / 2 - 0.32);
  const x = main.gx * LOT + off;
  const z = main.gy * LOT + off;
  const g = new THREE.Group();
  const gold = keep(new THREE.MeshStandardMaterial({ color: "#ffd27a", metalness: 0.8, roughness: 0.3 }));
  const podium = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.16, 0.18, 0.06, 20)), gold);
  podium.position.y = 0.03;
  podium.castShadow = true;
  const figure = mayorFigure(currentMayorLook(), keep);
  figure.position.y = 0.06;
  figure.scale.setScalar(0.85);
  g.add(podium, figure);
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
    if (b.kind !== "tower") continue;
    const half = (b.floors[0]?.size ?? 0.6) / 2;
    if (half + 0.2 > edge) continue; // No room on this block.
    const cx = b.gx * LOT;
    const cz = b.gy * LOT;
    const spots: [number, number][] = [];
    for (let side = 0; side < 4; side++) {
      for (const t of [-0.62, 0, 0.62]) {
        const a = t * edge;
        const [x, z] = side === 0 ? [a, -edge] : side === 1 ? [edge, a] : side === 2 ? [a, edge] : [-edge, a];
        // The mayor stands on this block's south-east corner.
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

/**
 * What the city has grown at its milestones (see lib/milestones): a park
 * with a fountain to the south, a train looping round, a harbour with
 * boats to the east, a stadium to the west, and a bridge to an island.
 * Returns how far it all reaches from the centre, and its animation.
 */
function addMilestones(
  scene: THREE.Scene,
  reached: number,
  g0: number,
  g1: number,
  theme: SceneTheme,
  keep: Keep,
  labels: CSS2DObject[] | null,
  still: boolean,
): { extent: number; bounds: [number, number, number, number]; tick: ((dt: number) => boolean) | null } {
  const has = (id: Parameters<typeof isUnlocked>[0]) => isUnlocked(id, reached);
  const mid = (g0 + g1) / 2;
  const W = g0 - 0.7;
  const E = g1 + 0.7;
  let extent = 0;
  // Everything grown, as [minX, maxX, minZ, maxZ], to frame the camera.
  const bounds: [number, number, number, number] = [g0, g1, g0, g1];
  const reach = (x: number, z: number) => {
    extent = Math.max(extent, Math.hypot(x - mid, z - mid));
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.max(bounds[1], x);
    bounds[2] = Math.min(bounds[2], z);
    bounds[3] = Math.max(bounds[3], z);
  };
  const anims: ((t: number) => void)[] = [];
  let seed = 41;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => keep(new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra }));
  const glow = (color: string, k = 1.6) => keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: false }));
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  const label = (text: string, x: number, y: number, z: number) => {
    if (!labels) return;
    const el = document.createElement("div");
    el.className = "city3d-label landmark";
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.set(x, y, z);
    scene.add(o);
    labels.push(o);
  };
  const trunkMat = std("#6e4f38", { roughness: 0.9 });
  const leafMat = std("#3f8a5a", { flatShading: true });
  const trunkGeo = keep(new THREE.CylinderGeometry(0.03, 0.04, 0.26, 6));
  const leafGeo = keep(new THREE.IcosahedronGeometry(0.2, 0));
  const tree = (x: number, z: number, s = 1) => {
    const t = new THREE.Mesh(trunkGeo, trunkMat);
    t.position.set(x, 0.13 * s, z);
    t.scale.setScalar(s);
    const l = new THREE.Mesh(leafGeo, leafMat);
    l.position.set(x, 0.38 * s, z);
    l.scale.set(s, s * 1.15, s);
    l.rotation.y = rnd() * Math.PI;
    l.castShadow = true;
    scene.add(t, l);
  };
  const lampPost = (x: number, z: number) => {
    box(0.025, 0.45, 0.025, std(theme.crane), x, 0.225, z);
    const bulb = new THREE.Mesh(keep(new THREE.SphereGeometry(0.06, 8, 6)), glow(theme.lamp, 1.2));
    bulb.position.set(x, 0.47, z);
    scene.add(bulb);
  };

  // Land round the city once there's something to put on it.
  const park = has("park");
  const stadium = has("stadium");
  if (park) {
    const x0 = stadium ? W - 5 : W - 1.2;
    const x1 = E + 1.2;
    const z0 = W - 1.2;
    const z1 = E + 4.6;
    box(x1 - x0, 0.28, z1 - z0, std(theme.ground, { roughness: 0.95 }), (x0 + x1) / 2, -0.16, (z0 + z1) / 2);
    reach(x0, z0);
    reach(x1, z1);
  }

  // 25 — a park to the south, with paths and trees.
  const parkZ = E + 2.6;
  if (park) {
    const pw = Math.max(3.4, Math.min(g1 - g0, 6));
    box(pw, 0.02, 3, std(theme.grass, { roughness: 1 }), mid, 0.0, parkZ);
    const path = std(theme.stone, { roughness: 0.95 });
    box(pw, 0.025, 0.22, path, mid, 0.004, parkZ);
    box(0.22, 0.025, 3, path, mid, 0.004, parkZ);
    for (let i = 0; i < 14; i++) {
      const x = mid + (rnd() - 0.5) * (pw - 0.5);
      const z = parkZ + (rnd() - 0.5) * 2.5;
      if (Math.abs(x - mid) < 0.35 || Math.abs(z - parkZ) < 0.35) continue;
      tree(x, z, 0.8 + rnd() * 0.5);
    }
    lampPost(mid - 0.3, parkZ - 0.3);
    lampPost(mid + 0.3, parkZ + 0.3);
    label("Park", mid - pw / 2 + 0.4, 0.7, parkZ + 1.2);
    reach(mid - pw / 2, parkZ + 1.5);
    reach(mid + pw / 2, parkZ + 1.5);
  }

  // 50 — the fountain in the middle of the park: the town square.
  if (has("fountain")) {
    const stone = std(theme.stone, { roughness: 0.6 });
    const water = glow("#7fc4ff", 0.9);
    const basin = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.62, 0.66, 0.16, 28)), stone);
    basin.position.set(mid, 0.08, parkZ);
    basin.castShadow = true;
    const pool = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.55, 0.55, 0.02, 28)), water);
    pool.position.set(mid, 0.155, parkZ);
    const column = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.06, 0.09, 0.42, 10)), stone);
    column.position.set(mid, 0.3, parkZ);
    const bowl = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.24, 0.1, 0.07, 18)), stone);
    bowl.position.set(mid, 0.52, parkZ);
    const spray = new THREE.Mesh(keep(new THREE.ConeGeometry(0.16, 0.36, 14, 1, true)), keep(new THREE.MeshBasicMaterial({ color: "#bfe3ff", transparent: true, opacity: 0.55, side: THREE.DoubleSide, toneMapped: false })));
    spray.position.set(mid, 0.73, parkZ);
    spray.rotation.x = Math.PI;
    scene.add(basin, pool, column, bowl, spray);
    anims.push((t) => {
      const k = 1 + 0.08 * Math.sin(t * 6);
      spray.scale.set(k, 2 - k, k);
    });
    label("Town square", mid, 1.1, parkZ);
  }

  // 100 — a train line round the whole city.
  if (has("train")) {
    const d = 0.55;
    const a0 = W - d;
    const a1 = E + d;
    const rail = std("#7a7f96", { metalness: 0.7, roughness: 0.35 });
    const bed = std(theme.stone, { roughness: 1 });
    const len = a1 - a0;
    for (const [x, z, alongX] of [
      [mid, a0, true],
      [mid, a1, true],
      [a0, mid, false],
      [a1, mid, false],
    ] as [number, number, boolean][]) {
      box(alongX ? len + 0.3 : 0.3, 0.03, alongX ? 0.3 : len + 0.3, bed, x, 0.015, z);
      for (const o of [-0.07, 0.07]) box(alongX ? len + 0.14 : 0.025, 0.03, alongX ? 0.025 : len + 0.14, rail, alongX ? x : x + o, 0.045, alongX ? z + o : z);
    }
    reach(a0, a0);
    reach(a1, a1);
    const path = [
      new THREE.Vector3(a0, 0, a0),
      new THREE.Vector3(a1, 0, a0),
      new THREE.Vector3(a1, 0, a1),
      new THREE.Vector3(a0, 0, a1),
    ];
    const lap = 4 * len;
    const paint = std("#d9534f", { metalness: 0.4, roughness: 0.4 });
    const coach = std("#e8e4dc", { metalness: 0.3, roughness: 0.5 });
    const lit = glow("#ffd27a", 1.5);
    const cars: THREE.Group[] = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(keep(new THREE.BoxGeometry(0.5, 0.16, 0.18)), i === 0 ? paint : coach);
      body.position.y = 0.15;
      body.castShadow = true;
      const win = new THREE.Mesh(keep(new THREE.BoxGeometry(0.42, 0.05, 0.185)), lit);
      win.position.y = 0.17;
      g.add(body, win);
      scene.add(g);
      cars.push(g);
    }
    const at = (dist: number, obj: THREE.Object3D) => {
      let d2 = ((dist % lap) + lap) % lap;
      for (let i = 0; i < 4; i++) {
        const p = path[i];
        const q = path[(i + 1) % 4];
        if (d2 <= len) {
          const k = d2 / len;
          obj.position.set(p.x + (q.x - p.x) * k, 0.03, p.z + (q.z - p.z) * k);
          obj.rotation.y = -Math.atan2(q.z - p.z, q.x - p.x);
          return;
        }
        d2 -= len;
      }
    };
    let pos = lap * 0.3;
    const place = () => cars.forEach((c, i) => at(pos - i * 0.56, c));
    place();
    anims.push((t) => {
      pos = lap * 0.3 + t * 0.9;
      place();
    });
    label("Train line", a1, 0.7, a1);
  }

  // 250 — the harbour: water to the east, a pier, a lighthouse and boats.
  const shore = E + 1.2;
  if (has("harbour")) {
    const waterMat = keep(new THREE.MeshStandardMaterial({ color: theme.water, roughness: 0.25, metalness: 0.3 }));
    const sea = new THREE.Mesh(keep(new THREE.BoxGeometry(14, 0.2, (E - W) + 16)), waterMat);
    sea.position.set(shore + 7, -0.14, mid);
    sea.receiveShadow = true;
    scene.add(sea);
    box(0.18, 0.12, (E - W) + 6, std(theme.stone, { roughness: 0.9 }), shore, -0.02, mid + 1.6);
    const pierZ = mid - Math.max(1.4, (g1 - g0) * 0.3);
    const wood = std("#7a5a40", { roughness: 0.9 });
    box(2.2, 0.06, 0.34, wood, shore + 1.1, 0.03, pierZ);
    box(0.22, 0.5, 0.22, std("#f1ece6"), shore + 2.3, 0.25, pierZ);
    box(0.24, 0.08, 0.24, std("#d9534f"), shore + 2.3, 0.54, pierZ);
    const beam = new THREE.Mesh(keep(new THREE.SphereGeometry(0.08, 10, 8)), glow("#fff2c4", 2.2));
    beam.position.set(shore + 2.3, 0.62, pierZ);
    scene.add(beam);
    const hulls = ["#e8e4dc", "#3f7fd9", "#d9a441"];
    const boats: { g: THREE.Group; phase: number; y: number }[] = [];
    hulls.forEach((c, i) => {
      const g = new THREE.Group();
      const hull = new THREE.Mesh(keep(new THREE.BoxGeometry(0.62, 0.12, 0.22)), std(c, { roughness: 0.5 }));
      hull.position.y = 0.04;
      const cabin = new THREE.Mesh(keep(new THREE.BoxGeometry(0.22, 0.1, 0.16)), std("#f1ece6"));
      cabin.position.set(-0.06, 0.15, 0);
      const mast = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.01, 0.01, 0.5, 5)), std("#c9c3b8"));
      mast.position.set(0.08, 0.32, 0);
      const light = new THREE.Mesh(keep(new THREE.SphereGeometry(0.025, 6, 5)), glow("#ffd27a", 1.6));
      light.position.set(0.08, 0.58, 0);
      g.add(hull, cabin, mast, light);
      g.position.set(shore + 0.8 + i * 0.75, 0, pierZ + (i % 2 ? 0.45 : -0.45));
      g.rotation.y = (i - 1) * 0.25;
      scene.add(g);
      boats.push({ g, phase: i * 1.7, y: 0 });
    });
    anims.push((t) => {
      for (const b of boats) {
        b.g.position.y = 0.02 * Math.sin(t * 1.4 + b.phase);
        b.g.rotation.z = 0.04 * Math.sin(t * 1.1 + b.phase);
      }
    });
    reach(shore + 4, pierZ);
    label("Harbour", shore + 1.6, 0.9, pierZ - 0.5);
  }

  // 500 — a stadium with floodlights to the west.
  if (stadium) {
    const sx = W - 3;
    const stand = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.35, 1.15, 0.5, 40, 1, true)), keep(new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.7, side: THREE.DoubleSide })));
    stand.scale.set(1, 1, 1.45);
    stand.position.set(sx, 0.25, mid);
    stand.castShadow = true;
    const pitch = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.1, 1.1, 0.03, 40)), std("#3f8a4f", { roughness: 1 }));
    pitch.scale.set(1, 1, 1.45);
    pitch.position.set(sx, 0.02, mid);
    const lines = new THREE.Mesh(keep(new THREE.BoxGeometry(0.03, 0.01, 1.9)), glow("#ffffff", 0.9));
    lines.position.set(sx, 0.04, mid);
    lines.rotation.y = Math.PI / 2;
    scene.add(stand, pitch, lines);
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const x = sx + dx * 1.15;
      const z = mid + dz * 1.75;
      box(0.04, 1.1, 0.04, std(theme.crane, { metalness: 0.6 }), x, 0.55, z);
      const lamp = box(0.2, 0.1, 0.06, glow("#f4f7ff", 2.2), x, 1.12, z);
      lamp.lookAt(sx, 0, mid);
    }
    reach(sx - 1.5, mid - 2);
    label("Stadium", sx, 1.5, mid);
  }

  // 1,000 — a bridge across the harbour to a second island.
  if (has("island")) {
    const ix = shore + 8.2;
    const land = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.3, 2.5, 0.3, 32)), std(theme.ground, { roughness: 0.95 }));
    land.position.set(ix, -0.1, mid);
    land.receiveShadow = true;
    scene.add(land);
    const wall = std(theme.wall, { roughness: 0.75, metalness: 0.08 });
    const win = glow(theme.lit, 1.1);
    [
      [-0.7, -0.6, 1.6],
      [0.5, -0.4, 2.4],
      [-0.2, 0.7, 1.2],
      [0.9, 0.8, 0.9],
    ].forEach(([dx, dz, h]) => {
      box(0.62, h, 0.62, wall, ix + dx, h / 2, mid + dz);
      for (let y = 0.25; y < h - 0.1; y += 0.3) box(0.64, 0.08, 0.64, win, ix + dx, y, mid + dz);
    });
    for (let i = 0; i < 6; i++) tree(ix + (rnd() - 0.5) * 3.4, mid + (rnd() < 0.5 ? -1 : 1) * (1.3 + rnd() * 0.6), 0.9);
    const x0 = shore;
    const x1 = ix - 2.2;
    const deck = std(theme.roof, { metalness: 0.3, roughness: 0.6 });
    box(x1 - x0, 0.06, 0.42, deck, (x0 + x1) / 2, 0.32, mid);
    const steel = std("#b9b2ff", { metalness: 0.7, roughness: 0.3 });
    const towers = [x0 + (x1 - x0) * 0.3, x0 + (x1 - x0) * 0.7];
    for (const tx of towers) for (const s of [-1, 1]) box(0.07, 1.2, 0.07, steel, tx, 0.6, mid + s * 0.2);
    // Cables: a sag between the towers, and down to each shore.
    const cable = (a: THREE.Vector3, b: THREE.Vector3, sag: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 16; i++) {
        const k = i / 16;
        pts.push(new THREE.Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k - sag * 4 * k * (1 - k), a.z));
      }
      const geo = keep(new THREE.BufferGeometry().setFromPoints(pts));
      scene.add(new THREE.Line(geo, keep(new THREE.LineBasicMaterial({ color: "#d6d2ff" }))));
    };
    for (const s of [-1, 1]) {
      const z = mid + s * 0.2;
      cable(new THREE.Vector3(x0, 0.36, z), new THREE.Vector3(towers[0], 1.2, z), -0.2);
      cable(new THREE.Vector3(towers[0], 1.2, z), new THREE.Vector3(towers[1], 1.2, z), 0.7);
      cable(new THREE.Vector3(towers[1], 1.2, z), new THREE.Vector3(x1, 0.36, z), -0.2);
    }
    for (let x = x0 + 0.4; x < x1; x += 0.7) {
      for (const s of [-1, 1]) {
        const b = new THREE.Mesh(keep(new THREE.SphereGeometry(0.03, 6, 5)), glow(theme.lamp, 1.4));
        b.position.set(x, 0.4, mid + s * 0.2);
        scene.add(b);
      }
    }
    reach(ix + 2.5, mid + 2.5);
    reach(ix + 2.5, mid - 2.5);
    label("The island", ix, 2.9, mid);
  }

  const moving = !still && anims.length > 0 && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let t = 0;
  return {
    extent,
    bounds,
    tick: moving
      ? (dt) => {
          if (document.documentElement.dataset.cityMotion === "off") return false;
          t += dt;
          for (const a of anims) a(t);
          return true;
        }
      : null,
  };
}

function addTraffic(scene: THREE.Scene, city: City, lines: number[], g0: number, g1: number, tallestKey: string, keep: Keep): ((dt: number) => boolean) | null {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.cityMotion === "off") return null;
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
  if (top && top.kind === "tower" && !top.planned) {
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
  // Settings → Your city can swap the mayor's figure (set on the page by applyLook).
  const [look, setLook] = useState(currentMayorLook);
  useEffect(() => {
    const o = new MutationObserver(() => setLook(currentMayorLook()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mayor-look"] });
    return () => o.disconnect();
  }, []);

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
      c.autoRotate = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches && document.documentElement.dataset.cityMotion !== "off";
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
      let best: { d: number; room: Room; key: string; floor: string; house?: number } | null = null;
      for (const wm of built.windowMeshes) {
        const h = ray.intersectObject(wm.mesh, false)[0];
        if (h && h.instanceId !== undefined && (!best || h.distance < best.d)) best = { d: h.distance, ...wm.rooms[h.instanceId] };
      }
      const x = clientX - r.left;
      const y = clientY - r.top;
      if (best && (!hitB || best.d <= hitB.distance + 0.05)) return { key: best.key, room: best.room, floor: best.floor, house: best.house, x, y };
      if (hitB) {
        const u = hitB.object.userData;
        return { key: u.key as string, room: (u.room as Room | undefined) ?? null, floor: (u.floor as string) ?? null, house: u.house as number | undefined, x, y };
      }
      return null;
    };

    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent) => {
      if (down && (e.buttons & 1) !== 0) return;
      const p = pickAt(e.clientX, e.clientY);
      const key = p ? (p.house !== undefined ? `${p.key}#${p.house}` : p.key) : null;
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
  }, [city, range, day, mayor, look]);

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
  ctx.fillText("Built with TodoCity", W - 32, H - 26);

  built.dispose();
  composer.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}
