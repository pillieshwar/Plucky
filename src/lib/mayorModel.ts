import * as THREE from "three";

export type MayorLook = "man" | "woman";

/** The mayor's figure the user picked (set on the page by `applyLook`). */
export function currentMayorLook(): MayorLook {
  return typeof document !== "undefined" && document.documentElement.dataset.mayorLook === "woman" ? "woman" : "man";
}

type Keep = <T extends { dispose: () => void }>(x: T) => T;

const SUIT = "#262a44";
const SKIN = "#e3b48d";
const SASH = "#a29bff";
const GOLD = "#ffd27a";
const SHIRT = "#f3f1ea";

/**
 * The mayor, about 0.62 tall, standing at the origin and facing +z: a dark
 * suit, a purple sash, a gold chain of office — and a top hat for the man,
 * a skirt suit and a bob for the woman. Built from simple shapes so it
 * suits the city's low-poly look.
 */
export function mayorFigure(look: MayorLook, keep: Keep = (x) => x): THREE.Group {
  const g = new THREE.Group();
  const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    keep(new THREE.MeshStandardMaterial({ color, roughness: 0.62, ...extra }));
  const suit = mat(SUIT);
  const skin = mat(SKIN, { roughness: 0.75 });
  const shirt = mat(SHIRT, { roughness: 0.8 });
  const sash = mat(SASH, { emissive: "#5249d9", emissiveIntensity: 0.35 });
  const gold = mat(GOLD, { metalness: 0.8, roughness: 0.3, emissive: "#6b4a10", emissiveIntensity: 0.25 });
  const dark = mat("#101218", { roughness: 0.4 });
  const hair = mat(look === "woman" ? "#4a2c1d" : "#2b201a", { roughness: 0.85 });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(keep(geo), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  const woman = look === "woman";

  // Shoes and legs.
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.03, 0.018, 0.05), dark, side * 0.026, 0.009, 0.008);
    if (woman) add(new THREE.CylinderGeometry(0.014, 0.012, 0.13, 10), skin, side * 0.024, 0.08, 0);
    else add(new THREE.CylinderGeometry(0.021, 0.019, 0.16, 10), suit, side * 0.026, 0.095, 0);
  }
  // A skirt for the woman.
  if (woman) add(new THREE.CylinderGeometry(0.052, 0.074, 0.1, 18), suit, 0, 0.175, 0);

  // Jacket, with the shirt and (for the man) a tie showing at the front.
  const bodyY = woman ? 0.28 : 0.27;
  add(new THREE.CylinderGeometry(woman ? 0.05 : 0.058, woman ? 0.056 : 0.066, woman ? 0.15 : 0.17, 18), suit, 0, bodyY, 0);
  const vee = add(new THREE.BoxGeometry(0.03, 0.07, 0.01), shirt, 0, bodyY + 0.045, woman ? 0.047 : 0.054);
  vee.rotation.x = -0.12;
  if (!woman) add(new THREE.BoxGeometry(0.012, 0.06, 0.008), mat("#b23a48"), 0, bodyY + 0.03, 0.06);
  // Shoulders.
  add(new THREE.SphereGeometry(woman ? 0.05 : 0.058, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), suit, 0, bodyY + (woman ? 0.07 : 0.08), 0).scale.set(1, 0.45, 0.9);

  // Arms, a little out from the body, and hands.
  for (const side of [-1, 1]) {
    const arm = add(new THREE.CylinderGeometry(0.016, 0.018, 0.15, 10), suit, side * (woman ? 0.062 : 0.072), bodyY + 0.005, 0);
    arm.rotation.z = side * 0.14;
    add(new THREE.SphereGeometry(0.017, 10, 8), skin, side * (woman ? 0.072 : 0.082), bodyY - 0.08, 0.004);
  }

  // The sash, shoulder to hip, across the front.
  const band = add(new THREE.TorusGeometry(woman ? 0.056 : 0.064, 0.009, 6, 24), sash, 0, bodyY - 0.005, 0);
  band.rotation.set(Math.PI / 2.5, 0, 0.55);
  band.scale.set(1, 1.05, 1);

  // Neck, head and face.
  const headY = bodyY + (woman ? 0.15 : 0.16);
  add(new THREE.CylinderGeometry(0.018, 0.02, 0.04, 10), skin, 0, headY - 0.06, 0);
  add(new THREE.SphereGeometry(0.052, 20, 16), skin, 0, headY, 0);
  for (const side of [-1, 1]) add(new THREE.SphereGeometry(0.006, 8, 6), dark, side * 0.018, headY + 0.006, 0.048);
  const smile = add(new THREE.TorusGeometry(0.014, 0.0028, 4, 12, Math.PI), mat("#9a4a3a"), 0, headY - 0.017, 0.048);
  smile.rotation.z = Math.PI;
  // Rosy cheeks.
  const cheek = mat("#f0a091", { roughness: 0.9 });
  for (const side of [-1, 1]) add(new THREE.SphereGeometry(0.008, 8, 6), cheek, side * 0.03, headY - 0.01, 0.041).scale.set(1, 0.7, 0.4);

  // Hair: short for the man, a bob for the woman.
  if (woman) {
    add(new THREE.SphereGeometry(0.058, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.42), hair, 0, headY + 0.006, -0.002);
    const back = add(new THREE.CylinderGeometry(0.058, 0.064, 0.075, 20, 1, true, Math.PI * 0.3, Math.PI * 1.4), hair, 0, headY - 0.025, -0.002);
    (back.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    // The open side of the bob faces front (theta 0 is +z); a fringe over the forehead.
    const fringe = add(new THREE.SphereGeometry(0.056, 16, 8, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.2, Math.PI * 0.14), hair, 0, headY + 0.004, 0.003);
    fringe.rotation.x = 0.1;
  } else {
    add(new THREE.SphereGeometry(0.055, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), hair, 0, headY + 0.004, -0.004);
  }

  // The gold chain of office, with its medallion.
  const chain = add(new THREE.TorusGeometry(woman ? 0.04 : 0.046, 0.0045, 6, 28), gold, 0, headY - 0.085, 0.006);
  chain.rotation.x = Math.PI / 2 - 0.42;
  add(new THREE.CylinderGeometry(0.014, 0.014, 0.005, 16), gold, 0, headY - 0.108, woman ? 0.05 : 0.058).rotation.x = Math.PI / 2;

  // A top hat for the man, a small gold brooch on the woman's lapel.
  if (!woman) {
    add(new THREE.CylinderGeometry(0.072, 0.072, 0.009, 24), dark, 0, headY + 0.045, 0);
    add(new THREE.CylinderGeometry(0.044, 0.047, 0.085, 24), dark, 0, headY + 0.09, 0);
    add(new THREE.CylinderGeometry(0.048, 0.048, 0.016, 24), sash, 0, headY + 0.058, 0);
  } else {
    add(new THREE.SphereGeometry(0.008, 8, 6), gold, -0.03, bodyY + 0.04, 0.05);
  }
  return g;
}

const avatarCache = new Map<string, string>();

/**
 * A head-and-shoulders picture of the mayor, as a data URL: drawn once with
 * three.js and kept. Null where WebGL isn't available.
 */
export function mayorPortrait(look: MayorLook, size = 96): string | null {
  const key = `${look}:${size}`;
  const hit = avatarCache.get(key);
  if (hit) return hit;
  const things: { dispose: () => void }[] = [];
  const keep: Keep = (x) => {
    things.push(x);
    return x;
  };
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#5249d9", 1.6));
    const sun = new THREE.DirectionalLight("#ffffff", 2.4);
    sun.position.set(0.6, 1.2, 1.4);
    scene.add(sun);
    const fig = mayorFigure(look, keep);
    fig.rotation.y = -0.32;
    scene.add(fig);
    const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 10);
    const top = look === "woman" ? 0.43 : 0.46;
    camera.position.set(0.08, top + 0.02, 0.62);
    camera.lookAt(0, top - 0.02, 0);
    renderer.render(scene, camera);
    const url = canvas.toDataURL("image/png");
    avatarCache.set(key, url);
    return url;
  } catch {
    return null;
  } finally {
    for (const t of things) t.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
