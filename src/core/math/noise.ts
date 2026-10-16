/**
 * Value noise + fbm + ridged noise. Used for terrain, wind turbulence and
 * procedural texture generation.
 *
 * Seeded via an integer permutation table so world generation is deterministic
 * from `hashString(seed)`. No allocation in the inner loops.
 */

import { hash21 } from './rng';

export class Noise2D {
  private readonly perm: Uint8Array;

  constructor(seed: number) {
    // Fisher-Yates over a 256-entry table, using a deterministic LCG seeded by `seed`.
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed >>> 0 || 1;
    for (let i = 255; i > 0; i--) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private grad(hash: number, x: number, y: number): number {
    // 8 gradient directions, chosen by the low 3 bits of the hash.
    switch (hash & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  }

  /** Gradient (Perlin-style) noise in roughly [-1, 1]. */
  sample(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    // Quintic smoothstep for continuous first and second derivatives.
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    const p = this.perm;
    const aa = p[p[xi & 255] + (yi & 255)];
    const ab = p[p[xi & 255] + ((yi + 1) & 255)];
    const ba = p[p[(xi + 1) & 255] + (yi & 255)];
    const bb = p[p[(xi + 1) & 255] + ((yi + 1) & 255)];

    const x1 = this.grad(aa, xf, yf) + u * (this.grad(ba, xf - 1, yf) - this.grad(aa, xf, yf));
    const x2 =
      this.grad(ab, xf, yf - 1) + u * (this.grad(bb, xf - 1, yf - 1) - this.grad(ab, xf, yf - 1));
    return x1 + v * (x2 - x1);
  }

  /** Fractal Brownian motion. Returns roughly [-1, 1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.sample(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Ridged multifractal — sharp crests. Good for mountain ridges and for
   * wind-shear bands. Returns [0, 1].
   */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.sample(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** Domain-warped fbm — breaks up the grid-aligned look of plain fbm. */
  warpedFbm(x: number, y: number, warp = 0.6, octaves = 5): number {
    const wx = this.fbm(x + 5.2, y + 1.3, 3);
    const wy = this.fbm(x + 9.7, y + 7.1, 3);
    return this.fbm(x + warp * wx, y + warp * wy, octaves);
  }
}

/**
 * 1D value noise for gust envelopes and time-series turbulence.
 * Stateless: interpolates hash21 over the integer lattice with smoothstep.
 */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash21(i, seed);
  const b = hash21(i + 1, seed);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}

/** Multi-octave 1D noise in [-1, 1]. */
export function fbm1(x: number, octaves = 4, seed = 0): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise1(x * freq, seed + i * 977);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
