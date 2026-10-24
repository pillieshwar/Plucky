import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FLOOR, LOT, heightOf, rangeStart, startOfToday, type Building, type City, type CityRange } from "../lib/city";
import type { CityWindow } from "../lib/types";

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
  window: CityWindow | null;
  x: number;
  y: number;
}

interface Built {
  scene: THREE.Scene;
  /** Outline (tint) the building under the pointer. */
  setHover: (key: string | null) => void;
  /** Building bodies, for picking (userData.key). */
  bodies: THREE.Mesh[];
  /** Lit windows: the instanced meshes and which window each instance is. */
  windowMeshes: { mesh: THREE.InstancedMesh; wins: { w: CityWindow; key: string }[] }[];
  labels: CSS2DObject[];
  radius: number;
  center: THREE.Vector3;
  dispose: () => void;
}

const SIDES: { n: [number, number] }[] = [{ n: [0, -1] }, { n: [1, 0] }, { n: [0, 1] }, { n: [-1, 0] }];

/** Build the whole city as a three.js scene. */
export function buildScene(city: City, theme: SceneTheme, range: CityRange, now: Date, opts: { labels: boolean }): Built {
  const scene = new THREE.Scene();
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T) => {
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

  // Ground and streets.
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
  const groundGeo = keep(new THREE.BoxGeometry(span + 1.2, 0.3, span + 1.2));
  const groundMat = keep(new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 0.95 }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.set(mid, -0.15, mid);
  ground.receiveShadow = true;
  scene.add(ground);
  const streetMat = keep(new THREE.MeshStandardMaterial({ color: theme.street, roughness: 0.9 }));
  const lampGeo = keep(new THREE.SphereGeometry(0.07, 8, 6));
  const lampMat = keep(new THREE.MeshBasicMaterial({ color: theme.lamp }));
  const postGeo = keep(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6));
  const postMat = keep(new THREE.MeshStandardMaterial({ color: theme.crane }));
  for (let gi = gMin; gi <= gMax + 1; gi++) {
    const s = (gi - 0.5) * LOT;
    if (s <= g0 + 0.01 || s >= g1 - 0.01) continue;
    for (const along of [true, false]) {
      const geo = keep(new THREE.BoxGeometry(along ? 0.42 : span, 0.02, along ? span : 0.42));
      const st = new THREE.Mesh(geo, streetMat);
      st.position.set(along ? s : mid, 0.011, along ? mid : s);
      st.receiveShadow = true;
      scene.add(st);
    }
  }
  for (let gi = gMin; gi <= gMax + 1; gi++) {
    for (let gj = gMin; gj <= gMax + 1; gj++) {
      const x = (gi - 0.5) * LOT + 0.3;
      const z = (gj - 0.5) * LOT + 0.3;
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, 0.25, z);
      scene.add(post);
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(x, 0.52, z);
      scene.add(lamp);
    }
  }

  // Buildings.
  const wallMat = keep(new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.75, metalness: 0.08 }));
  const hoverMat = keep(new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.75, metalness: 0.08, emissive: "#6a62ea", emissiveIntensity: 0.35 }));
  const roofMat = keep(new THREE.MeshStandardMaterial({ color: theme.roof, roughness: 0.8 }));
  const planMat = keep(new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.9, transparent: true, opacity: 0.45 }));
  const bodies: THREE.Mesh[] = [];
  const from = rangeStart(range, now);
  const today = startOfToday(now);
  type Slot = { m: THREE.Matrix4; w?: CityWindow; key: string };
  const dark: Slot[] = [];
  const lit: Slot[] = [];
  const fresh: Slot[] = [];
  const labels: CSS2DObject[] = [];
  let tallest = 1;
  const tmp = new THREE.Object3D();

  for (const b of city.buildings) {
    const H = heightOf(b);
    tallest = Math.max(tallest, H);
    const cx = b.gx * LOT;
    const cz = b.gy * LOT;
    const geo = keep(new THREE.BoxGeometry(b.size, H, b.size));
    const body = new THREE.Mesh(geo, b.planned ? planMat : [wallMat, wallMat, roofMat, wallMat, wallMat, wallMat]);
    body.position.set(cx, H / 2, cz);
    body.castShadow = !b.planned;
    body.receiveShadow = true;
    body.userData.key = b.key;
    scene.add(body);
    bodies.push(body);
    // A slim parapet on the roof.
    if (!b.planned) {
      const capGeo = keep(new THREE.BoxGeometry(b.size * 0.55, FLOOR * 0.35, b.size * 0.55));
      const cap = new THREE.Mesh(capGeo, roofMat);
      cap.position.set(cx, H + FLOOR * 0.17, cz);
      cap.castShadow = true;
      scene.add(cap);
    }
    if (!b.planned) placeWindows(b, cx, cz, (m, w) => {
      if (!w) dark.push({ m, key: b.key });
      else {
        const t = Date.parse(w.completed_at);
        const isFresh = range === "all" ? t >= today : t >= from;
        (isFresh ? fresh : lit).push({ m, w, key: b.key });
      }
    }, tmp);
    if (b.finished) addBeacon(scene, cx, H, cz, theme, keep);
    if (b.planned) addCrane(scene, cx, H, cz, theme, keep);
    if (opts.labels) {
      const el = document.createElement("div");
      el.className = "city3d-label";
      el.dataset.key = b.key;
      el.textContent = b.name;
      const label = new CSS2DObject(el);
      label.position.set(cx, H + (b.finished ? 1.1 : b.planned ? 2.6 : 0.45), cz);
      label.center.set(0.5, 1);
      scene.add(label);
      labels.push(label);
    }
  }

  // Windows as three instanced meshes: dark, lit earlier, and lit recently (glowing).
  const winGeo = keep(new THREE.PlaneGeometry(1, 1));
  const windowMeshes: Built["windowMeshes"] = [];
  const instanced = (slots: Slot[], mat: THREE.Material, pickable: boolean) => {
    if (!slots.length) return;
    const mesh = new THREE.InstancedMesh(winGeo, mat, slots.length);
    slots.forEach((s, i) => mesh.setMatrixAt(i, s.m));
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    if (pickable) windowMeshes.push({ mesh, wins: slots.map((s) => ({ w: s.w!, key: s.key })) });
  };
  instanced(dark, keep(new THREE.MeshStandardMaterial({ color: theme.dark, roughness: 0.4, metalness: 0.3 })), false);
  instanced(lit, keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.lit).multiplyScalar(0.95), fog: true })), true);
  instanced(fresh, keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.fresh).multiplyScalar(1.6), toneMapped: false })), true);

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
      const side = body.userData.key === key ? hoverMat : wallMat;
      body.material = [side, side, roofMat, wallMat, side, side];
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
    dispose: () => {
      for (const d of disposables) d.dispose();
      for (const l of labels) l.element.remove();
    },
  };
}

function placeWindows(b: Building, cx: number, cz: number, put: (m: THREE.Matrix4, w?: CityWindow) => void, tmp: THREE.Object3D) {
  const half = b.size / 2;
  const cell = b.size / b.per;
  for (let f = 1; f <= b.floors; f++) {
    const y = f * FLOOR + FLOOR * 0.47;
    for (let side = 0; side < 4; side++) {
      const [nx, nz] = SIDES[side].n;
      // Along the face, left to right seen from outside.
      const tx = -nz;
      const tz = nx;
      for (let slot = 0; slot < b.per; slot++) {
        const u = -half + (slot + 0.5) * cell;
        tmp.position.set(cx + nx * (half + 0.004) + tx * u, y, cz + nz * (half + 0.004) + tz * u);
        tmp.rotation.set(0, Math.atan2(nx, nz), 0);
        tmp.scale.set(cell * 0.52, FLOOR * 0.5, 1);
        tmp.updateMatrix();
        const i = (f - 1) * b.per * 4 + side * b.per + slot;
        put(tmp.matrix.clone(), b.windows[i]);
      }
    }
  }
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
  const mast = new THREE.Mesh(keep(new THREE.BoxGeometry(0.08, 2.4, 0.08)), mat);
  mast.position.set(x, h + 1.2, z);
  const jib = new THREE.Mesh(keep(new THREE.BoxGeometry(2.4, 0.07, 0.07)), mat);
  jib.position.set(x + 0.5, h + 2.3, z);
  const cable = new THREE.Mesh(keep(new THREE.BoxGeometry(0.015, 0.9, 0.015)), mat);
  cable.position.set(x + 1.4, h + 1.85, z);
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
  onPick?: (key: string) => void;
  onHover?: (p: Picked | null) => void;
  onInteract?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onPick, onHover, onInteract });
  cb.current = { onPick, onHover, onInteract };
  // Swap in a new city without rebuilding the renderer (set by the effect below).
  const setCity = useRef<((city: City, range: CityRange, now: Date) => void) | null>(null);
  const latest = useRef({ city, range, now });
  latest.current = { city, range, now };
  const day = now.toDateString();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const theme = dark ? NIGHT_3D : DUSK_3D;
    const first = latest.current;
    let built = buildScene(first.city, theme, first.range, first.now, { labels: !!labels });
    let hoverKey: string | null = null;
    let flyTo: { from: THREE.Vector3; to: THREE.Vector3; start: number; key: string } | null = null;
    let dirty = true;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: !!still });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    homeCamera(camera, built, still ? 1.25 : 1);
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
      built = buildScene(c, theme, r, n, { labels: !!labels });
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
      let best: { d: number; w: CityWindow; key: string } | null = null;
      for (const wm of built.windowMeshes) {
        const h = ray.intersectObject(wm.mesh, false)[0];
        if (h && h.instanceId !== undefined && (!best || h.distance < best.d)) best = { d: h.distance, ...wm.wins[h.instanceId] };
      }
      const x = clientX - r.left;
      const y = clientY - r.top;
      if (best && (!hitB || best.d <= hitB.distance + 0.05)) return { key: best.key, window: best.w, x, y };
      if (hitB) return { key: hitB.object.userData.key as string, window: null, x, y };
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
    const loop = (t: number) => {
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
  }, [city, range, day]);

  return <div ref={host} className="city3d" />;
}

/** The share picture: the city from a good angle, with its name and count. */
export function renderCityPicture(city: City, name: string, opts: { count: number | null; names: boolean; now: Date; dark: boolean }): HTMLCanvasElement {
  const W = 1200;
  const H = 630;
  const theme = opts.dark ? NIGHT_3D : DUSK_3D;
  const built = buildScene(city, theme, "week", opts.now, { labels: false });
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
