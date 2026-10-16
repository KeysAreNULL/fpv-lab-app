/**
 * Quaternion + 3x3 matrix helpers for the rigid-body integrator.
 *
 * Body frame used everywhere in this project (Betaflight / PX4 convention):
 *   +X = right,  +Y = up,  +Z = **forward**
 * so "forward" is +Z and yaw 0 faces +Z.
 */

import type { Vec3 } from './vec3';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });

export const QUAT_IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

export const cloneQuat = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

export const setQuat = (o: Quat, x: number, y: number, z: number, w: number): Quat => {
  o.x = x;
  o.y = y;
  o.z = z;
  o.w = w;
  return o;
};

export const quatLength = (q: Quat): number => Math.hypot(q.x, q.y, q.z, q.w);

export const normalizeQuat = (q: Quat): Quat => {
  const l = quatLength(q);
  if (l < 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
  const inv = 1 / l;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
};

export const quatMultiply = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

export const conjugateQuat = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/** Integrate orientation by angular velocity ω (rad/s, body frame) over dt. */
export const integrateQuat = (q: Quat, omega: Vec3, dt: number): Quat => {
  const dq = {
    x: 0.5 * dt * (omega.x * q.w + omega.y * q.z - omega.z * q.y),
    y: 0.5 * dt * (-omega.x * q.z + omega.y * q.w + omega.z * q.x),
    z: 0.5 * dt * (omega.x * q.y - omega.y * q.x + omega.z * q.w),
    w: 0.5 * dt * (-omega.x * q.x - omega.y * q.y - omega.z * q.z),
  };
  return normalizeQuat({
    x: q.x + dq.x,
    y: q.y + dq.y,
    z: q.z + dq.z,
    w: q.w + dq.w,
  });
};

export const quatFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const h = angle * 0.5;
  const s = Math.sin(h) / len;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
};

/** Yaw (heading) extracted from the quaternion — no roll/pitch coupling. */
export const quatYaw = (q: Quat): number => {
  // With +Z forward and +Y up, heading = atan2(forward.x, forward.z).
  const fx = 2 * (q.x * q.z + q.w * q.y);
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  return Math.atan2(fx, fz);
};

export const quatPitch = (q: Quat): number => {
  // Positive = nose up.
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  const upX = 2 * (q.x * q.y - q.w * q.z);
  return Math.atan2(-upX, upY);
};

export const quatRoll = (q: Quat): number => {
  // Positive = right side down (right-hand rule about +Z forward).
  const fwdY = 2 * (q.y * q.z + q.w * q.x);
  const fwdX = 1 - 2 * (q.x * q.x + q.y * q.y);
  return Math.atan2(fwdY, fwdX);
};

export const eulerToQuat = (roll: number, pitch: number, yaw: number): Quat => {
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  return {
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
    w: cr * cp * cy + sr * sp * sy,
  };
};

/** Body-frame basis vectors (columns of the rotation matrix). */
export interface Basis {
  /** +X in world coords (right). */
  right: Vec3;
  /** +Y in world coords (up). */
  up: Vec3;
  /** +Z in world coords (forward). */
  forward: Vec3;
}

export const quatToBasis = (q: Quat): Basis => {
  const { x, y, z, w } = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return {
    right: { x: 1 - 2 * (yy + zz), y: 2 * (xy + wz), z: 2 * (xz - wy) },
    up: { x: 2 * (xy - wz), y: 1 - 2 * (xx + zz), z: 2 * (yz + wx) },
    forward: { x: 2 * (xz + wy), y: 2 * (yz - wx), z: 1 - 2 * (xx + yy) },
  };
};

/**
 * Full inertia tensor in body frame as a 3x3 row-major array.
 * Used to apply gyroscopic off-diagonal coupling and to invert I.
 */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const mat3Identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const mat3MulVec = (m: Mat3, v: Vec3): Vec3 => ({
  x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
  y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
  z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
});

/** Invert a symmetric positive-definite 3x3 (inertia tensors always are). */
export const invertSpd3 = (m: Mat3): Mat3 => {
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[4];
  const e = m[5];
  const f = m[8];
  const c00 = d * f - e * e;
  const c01 = e * c - b * f;
  const c02 = b * e - c * d;
  const det = a * c00 + b * c01 + c * c02;
  if (Math.abs(det) < 1e-18) return mat3Identity();
  const inv = 1 / det;
  return [
    c00 * inv,
    c01 * inv,
    c02 * inv,
    c01 * inv,
    (a * f - c * c) * inv,
    (c * b - a * e) * inv,
    c02 * inv,
    (c * b - a * e) * inv,
    (a * d - b * b) * inv,
  ];
};

/** M^-1 · v — angular acceleration from angular momentum rate. */
export const invertMat3MulVec = (m: Mat3, v: Vec3): Vec3 => mat3MulVec(invertSpd3(m), v);
