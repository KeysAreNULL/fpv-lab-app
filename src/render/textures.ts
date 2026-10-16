/**
 * Procedural textures.
 *
 * Everything is generated into a canvas at load time from a seeded RNG, so the
 * app ships with no binary assets, no network requests and no licence
 * obligations — and the same seed always produces the same texture. Dropping a
 * CC0 texture pack into `render/vendor/` later is explicitly supported; see
 * AGENTS.md §9.
 *
 * Textures are cached by key and reused, because a drone with four matching
 * props must not allocate four identical 256×256 canvases.
 */

import * as THREE from 'three';
import { createRng, type Rng } from '../core/math/rng';
import { Noise2D } from '../core/math/noise';

export interface TextureOptions {
  size: number;
  seed: number | string;
  /** Repeat count across the mesh. */
  repeat?: number;
}

const cache = new Map<string, THREE.Texture>();

const cacheKey = (name: string, size: number, seed: number | string): string =>
  `${name}:${size}:${typeof seed === 'string' ? seed : seed}`;

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot build textures.');
  return { canvas, ctx };
}

function finish(
  canvas: HTMLCanvasElement,
  { repeat = 1 }: TextureOptions,
  key: string,
): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  cache.set(key, texture);
  return texture;
}

/** Fill with a base colour and per-pixel noise, the base of most surfaces. */
function baseNoiseFill(
  ctx: CanvasRenderingContext2D,
  size: number,
  rng: Rng,
  color: [number, number, number],
  amount: number,
): void {
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const jitter = (rng.next() - 0.5) * amount * 255;
    data[i] = Math.max(0, Math.min(255, color[0] + jitter));
    data[i + 1] = Math.max(0, Math.min(255, color[1] + jitter));
    data[i + 2] = Math.max(0, Math.min(255, color[2] + jitter));
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * 2×2 twill carbon fibre — the classic FPV frame weave. The diagonal twill
 * pattern is what makes a carbon frame look like carbon rather than grey plastic.
 */
export function carbonFibreTexture(options: TextureOptions): THREE.Texture {
  const key = cacheKey('carbon', options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;

  const { size } = options;
  const rng = createRng(options.seed);
  const { canvas, ctx } = makeCanvas(size);
  const cell = Math.max(2, Math.floor(size / 32));

  ctx.fillStyle = '#1a1c1f';
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      // 2×2 twill: the over/under pattern steps by one cell each row.
      const over = ((Math.floor(x / cell) - Math.floor(y / cell) + 40) % 4) < 2;
      const shade = over ? 46 + rng.next() * 26 : 24 + rng.next() * 14;
      const gradient = ctx.createLinearGradient(x, y, x + cell, y + cell);
      gradient.addColorStop(0, `rgb(${shade},${shade + 2},${shade + 5})`);
      gradient.addColorStop(0.5, `rgb(${shade + 18},${shade + 20},${shade + 24})`);
      gradient.addColorStop(1, `rgb(${shade - 8},${shade - 7},${shade - 4})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, cell, cell);
    }
  }
  return finish(canvas, options, key);
}

/** Green solder-mask PCB with copper traces and silkscreen. */
export function pcbTexture(options: TextureOptions): THREE.Texture {
  const key = cacheKey('pcb', options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;

  const { size } = options;
  const rng = createRng(options.seed);
  const { canvas, ctx } = makeCanvas(size);
  baseNoiseFill(ctx, size, rng, [12, 62, 40], 0.12);

  // Traces: orthogonal runs with 45° corners, the way a real layout goes.
  ctx.strokeStyle = '#1c7a4d';
  ctx.lineWidth = Math.max(1, size / 128);
  for (let i = 0; i < 60; i++) {
    let x = Math.floor(rng.range(0, size / 8)) * 8;
    let y = Math.floor(rng.range(0, size / 8)) * 8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segments = Math.floor(rng.range(2, 6));
    for (let s = 0; s < segments; s++) {
      const horizontal = rng.chance(0.5);
      const length = Math.floor(rng.range(2, 8)) * 8;
      if (horizontal) x += rng.chance(0.5) ? length : -length;
      else y += rng.chance(0.5) ? length : -length;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Pads.
  ctx.fillStyle = '#d9c27a';
  for (let i = 0; i < 90; i++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = size / 90;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Silkscreen.
  ctx.fillStyle = 'rgba(235,240,235,0.55)';
  ctx.font = `${Math.floor(size / 24)}px monospace`;
  for (let i = 0; i < 12; i++) {
    ctx.fillText(rng.pick(['C1', 'R4', 'U2', 'TP3', 'L1', 'D5', 'J4']), rng.next() * size * 0.8, rng.next() * size * 0.95);
  }

  return finish(canvas, options, key);
}

/** Injection-moulded plastic: the camera housing and VTX shell. */
export function plasticTexture(color: [number, number, number], options: TextureOptions): THREE.Texture {
  const key = cacheKey(`plastic-${color.join(',')}`, options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;
  const rng = createRng(options.seed);
  const { canvas, ctx } = makeCanvas(options.size);
  baseNoiseFill(ctx, options.size, rng, color, 0.07);
  // Fine moulding stipple.
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < options.size * 4; i++) {
    ctx.fillStyle = rng.chance(0.5) ? '#ffffff' : '#000000';
    ctx.fillRect(rng.next() * options.size, rng.next() * options.size, 1, 1);
  }
  ctx.globalAlpha = 1;
  return finish(canvas, options, key);
}

/** Anodised aluminium, for motor bells and heatsinks. */
export function aluminiumTexture(options: TextureOptions): THREE.Texture {
  const key = cacheKey('alu', options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;
  const rng = createRng(options.seed);
  const { canvas, ctx } = makeCanvas(options.size);
  baseNoiseFill(ctx, options.size, rng, [150, 154, 160], 0.08);
  // Brush lines.
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 220; i++) {
    ctx.strokeStyle = rng.chance(0.5) ? '#ffffff' : '#5a5f66';
    ctx.beginPath();
    const y = rng.next() * options.size;
    ctx.moveTo(0, y);
    ctx.lineTo(options.size, y + rng.range(-2, 2));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return finish(canvas, { ...options, repeat: options.repeat ?? 2 }, key);
}

/**
 * Terrain albedo. Ground cover is chosen by height and slope so the map reads
 * properly from the air: grass in the flats, rock on the ridges, dirt on the
 * slopes between them.
 */
export function groundTexture(
  size: number,
  seed: number | string,
  minHeight: number,
  maxHeight: number,
): THREE.Texture {
  const key = cacheKey(`ground:${minHeight}:${maxHeight}`, size, seed);
  const cached = cache.get(key);
  if (cached) return cached;

  const seedNum = typeof seed === 'string' ? createRng(seed).int(1, 1e9) : seed;
  const noise = new Noise2D(seedNum);
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const span = Math.max(maxHeight - minHeight, 1);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Blend between the ground colours over a few octaves.
      const n = noise.fbm((x / size) * 7, (y / size) * 7, 4);
      const detail = noise.sample((x / size) * 46, (y / size) * 46);
      const i = (y * size + x) * 4;

      const mixGrassRock = Math.max(0, Math.min(1, n * 0.8 + detail * 0.2));
      // Grass: desaturated green. Rock: cool grey. Blend through earth.
      const grass: [number, number, number] = [78, 104, 58];
      const rock: [number, number, number] = [124, 122, 116];
      const t = mixGrassRock;
      data[i] = grass[0] + (rock[0] - grass[0]) * t + detail * 12;
      data[i + 1] = grass[1] + (rock[1] - grass[1]) * t + detail * 12;
      data[i + 2] = grass[2] + (rock[2] - grass[2]) * t + detail * 12;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  void span;
  return finish(canvas, { size, seed, repeat: 26 }, key);
}

/** Corrugated metal siding, for the hangars. */
export function metalSidingTexture(options: TextureOptions): THREE.Texture {
  const key = cacheKey('siding', options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;
  const rng = createRng(options.seed);
  const { canvas, ctx } = makeCanvas(options.size);
  const { size } = options;
  const rib = size / 16;
  for (let x = 0; x < size; x += rib) {
    const gradient = ctx.createLinearGradient(x, 0, x + rib, 0);
    gradient.addColorStop(0, '#5f6771');
    gradient.addColorStop(0.4, '#98a1ab');
    gradient.addColorStop(0.6, '#828b95');
    gradient.addColorStop(1, '#4d545c');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, 0, rib, size);
  }
  // Rust streaks and panel bolts.
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = rng.pick(['#7a4a28', '#8a5a32', '#4a3a30']);
    ctx.fillRect(rng.next() * size, rng.next() * size, rng.range(1, 3), rng.range(10, 70));
  }
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#2b3038';
  for (let y = 0; y < size; y += size / 4) {
    for (let x = 0; x < size; x += rib * 2) {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, size / 256), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  return finish(canvas, options, key);
}

/** Concrete with aggregate speckle, for the town. */
export function concreteTexture(options: TextureOptions): THREE.Texture {
  const key = cacheKey('concrete', options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;
  const rng = createRng(options.seed);
  const { size } = options;
  const { canvas, ctx } = makeCanvas(size);
  baseNoiseFill(ctx, size, rng, [148, 146, 141], 0.1);
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < size * 3; i++) {
    const shade = rng.next();
    ctx.fillStyle = shade > 0.5 ? '#ffffff' : '#3a3a38';
    ctx.fillRect(rng.next() * size, rng.next() * size, 1, 1);
  }
  // Window bands, so buildings read as buildings from a distance.
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#2a3138';
  const floors = 4;
  for (let f = 0; f < floors; f++) {
    const y = ((f + 0.7) / floors) * size;
    for (let w = 0; w < 6; w++) {
      ctx.fillRect(((w + 0.5) / 6) * size - size / 24, y - size / 50, size / 12, size / 25);
    }
  }
  ctx.globalAlpha = 1;
  return finish(canvas, options, key);
}

/** Bark for tree trunks. */
export function barkTexture(options: TextureOptions): THREE.Texture {
  const key = cacheKey('bark', options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;
  const noise = new Noise2D(typeof options.seed === 'string' ? 7 : options.seed);
  const { size } = options;
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Stretch the noise vertically: bark runs along the trunk.
      const n = noise.fbm((x / size) * 14, (y / size) * 2.2, 4);
      const i = (y * size + x) * 4;
      data[i] = 70 + n * 55;
      data[i + 1] = 56 + n * 45;
      data[i + 2] = 42 + n * 34;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return finish(canvas, { ...options, repeat: options.repeat ?? 2 }, key);
}

/** Foliage canopy: clumped leaf colour with alpha holes at the edges. */
export function foliageTexture(options: TextureOptions): THREE.Texture {
  const key = cacheKey('foliage', options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;
  const rng = createRng(options.seed);
  const { size } = options;
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < size * 6; i++) {
    const r = rng.range(size / 90, size / 34);
    const g = rng.int(60, 150);
    ctx.fillStyle = `rgb(${g * 0.45},${g},${g * 0.42})`;
    ctx.globalAlpha = rng.range(0.55, 1);
    ctx.beginPath();
    ctx.ellipse(rng.next() * size, rng.next() * size, r, r * rng.range(0.6, 1.2), rng.next() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const texture = finish(canvas, options, key);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Prop blade. One tile of a three-blade prop: the blade runs up the canvas with
 * a rounded tip and a taper, and the hub is in the middle.
 */
export function propBladeTexture(options: TextureOptions): THREE.Texture {
  const key = cacheKey('blade', options.size, options.seed);
  const cached = cache.get(key);
  if (cached) return cached;
  const { size } = options;
  const { canvas, ctx } = makeCanvas(size);

  ctx.clearRect(0, 0, size, size);
  // Blade runs from the hub (centre) to the tip (top edge).
  const rootWidth = size * 0.16;
  const midWidth = size * 0.26;
  const tipWidth = size * 0.18;

  const gradient = ctx.createLinearGradient(0, size, 0, 0);
  gradient.addColorStop(0, '#2b2e33');
  gradient.addColorStop(0.4, '#3c4148');
  gradient.addColorStop(1, '#26292e');
  ctx.fillStyle = gradient;

  ctx.beginPath();
  ctx.moveTo(size / 2 - rootWidth / 2, size / 2);
  ctx.quadraticCurveTo(size / 2 - midWidth / 2, size * 0.2, size / 2 - tipWidth / 2, size * 0.03);
  ctx.quadraticCurveTo(size / 2, size * 0.005, size / 2 + tipWidth / 2, size * 0.03);
  ctx.quadraticCurveTo(size / 2 + midWidth / 2, size * 0.2, size / 2 + rootWidth / 2, size / 2);
  ctx.closePath();
  ctx.fill();

  // Pitch highlight: a brighter band where the blade twists.
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = Math.max(1, size / 128);
  ctx.stroke();

  const texture = finish(canvas, { ...options, repeat: 1 }, key);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Dispose every cached texture. Called when the renderer is torn down. */
export function disposeTextures(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}
