/**
 * 3-component vector maths. Mutating by default (the sim calls these millions of
 * times); the `*Vec` / `clone` variants are for setup code that needs to keep a value.
 *
 * Convention throughout this project: right-handed, X = right/east, Y = up,
 * Z = forward/south... actually see `axes.ts` for the body frame. All angles radians.
 */

import type { Quat } from './quat';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export const set = (o: Vec3, x: number, y: number, z: number): Vec3 => {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
};

export const copy = (o: Vec3, a: Vec3): Vec3 => {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
  return o;
};

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

/** In-place accumulate, used in hot loops. */
export const addScaled = (o: Vec3, a: Vec3, s: number): Vec3 => {
  o.x += a.x * s;
  o.y += a.y * s;
  o.z += a.z * s;
  return o;
};

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;

export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : vec3(0, 0, 0);
};

/** Clamp magnitude to `max`, preserving direction. */
export const clampLength = (a: Vec3, max: number): Vec3 => {
  const l = length(a);
  return l > max && l > 1e-12 ? scale(a, max / l) : clone(a);
};

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const minV = (a: Vec3, b: Vec3): Vec3 => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  z: Math.min(a.z, b.z),
});

export const maxV = (a: Vec3, b: Vec3): Vec3 => ({
  x: Math.max(a.x, b.x),
  y: Math.max(a.y, b.y),
  z: Math.max(a.z, b.z),
});

/**
 * Rotate `v` by unit quaternion `q` (x,y,z,w). Allocates.
 * Used for body→world conversion of thrust, drag axes, wind-relative velocity.
 */
export const applyQuat = (v: Vec3, q: Quat): Vec3 => {
  const { x, y, z, w } = q;
  // t = 2 * (q.xyz x v)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
};

/** Rotate `v` by the conjugate of `q` — world→body. */
export const applyQuatInv = (v: Vec3, q: Quat): Vec3 => {
  const x = -q.x;
  const y = -q.y;
  const z = -q.z;
  const w = q.w;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
};

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerpScalar = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Move `current` toward `target` by at most `maxDelta`. Rate limiting / slew. */
export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

/** Frame-rate independent exponential smoothing. `tau` is the 63% response time. */
export const damp = (current: number, target: number, tau: number, dt: number): number => {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
};

/** Damped spring toward target. Returns [value, velocity]. */
export const springDamp = (
  value: number,
  velocity: number,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): [number, number] => {
  const a = (target - value) * stiffness - velocity * damping;
  const v = velocity + a * dt;
  return [value + v * dt, v];
};

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-12), 0, 1);
  return t * t * (3 - 2 * t);
};

export const invLerp = (a: number, b: number, v: number): number => (b - a === 0 ? 0 : (v - a) / (b - a));
