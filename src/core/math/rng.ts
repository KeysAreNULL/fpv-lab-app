/**
 * Deterministic RNG + hashing. Everything procedural in this app seeds from here
 * so a seed string always regenerates the exact same world.
 */

/** Fast, well-distributed 32-bit PRNG. Returns a generator of floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a. Turns an arbitrary seed string into a 32-bit seed for mulberry32. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer hash → [0, 1). Useful for stable per-feature randomness without state. */
export function hash11(n: number): number {
  let x = Math.imul(n ^ 0x27d4eb2d, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export function hash21(x: number, y: number): number {
  return hash11(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663));
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Approximately standard normal (Box-Muller). */
  normal(): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
}

export function createRng(seed: number | string): Rng {
  const s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  const next = mulberry32(s);
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    normal: () => {
      // Guard against log(0) when the PRNG returns exactly 0.
      const u1 = 1 - next();
      const u2 = next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}
