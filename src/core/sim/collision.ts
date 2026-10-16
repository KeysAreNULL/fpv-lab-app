/**
 * Collision detection against terrain and static obstacles.
 *
 * The airframe is treated as a small oriented box rather than a point, because
 * the difference between clipping a prop tip and hitting a wall flat decides
 * whether you walk away or the arm snaps off. Contacts return an impulse so the
 * caller can resolve them and compute the impact energy that feeds damage.
 */

import { applyQuat, dot, length, type Vec3 } from '../math/vec3';
import type { Quat } from '../math/quat';
import type { Obstacle } from '../terrain/generate';

export interface Contact {
  /** Normal pointing away from the surface, unit. */
  normal: Vec3;
  /** Depth of penetration, metres. */
  depth: number;
  /** Impact speed along the normal, m/s. Positive = closing. */
  approachSpeed: number;
  /** What was hit. */
  kind: 'terrain' | 'obstacle' | 'water';
  /** Which part of the airframe made contact. */
  part: 'prop' | 'body' | 'camera' | 'motor';
  obstacleId?: string;
  /** Surface material, for damage damping. */
  surface: 'grass' | 'dirt' | 'metal' | 'concrete' | 'water' | 'foliage';
  /** Contact point, world frame. */
  point: Vec3;
}

export interface BodyShape {
  /** Prop tip radius from the CG, metres. */
  propRadius: number;
  /** Frame half-extents, metres. */
  halfExtents: Vec3;
  /** Height of the camera lens above the CG, metres. */
  cameraHeight: number;
  /** Prop plane offset above the CG, metres. */
  propHeight: number;
}

export interface CollisionWorld {
  terrainHeight(x: number, z: number): number;
  obstacles: readonly Obstacle[];
  /** Height of the water surface, or null when the map has no water. */
  waterHeight: number | null;
}

/** Probe points on the airframe that can make contact. */
const probeOffsets = (shape: BodyShape): { offset: Vec3; part: Contact['part']; scale: number }[] => [
  { offset: { x: 0, y: shape.propHeight, z: 0 }, part: 'prop', scale: shape.propRadius },
  { offset: { x: 0, y: shape.halfExtents.y, z: 0 }, part: 'body', scale: 0 },
  { offset: { x: 0, y: -shape.halfExtents.y, z: 0 }, part: 'body', scale: 0 },
  { offset: { x: shape.halfExtents.x, y: 0, z: 0 }, part: 'body', scale: 0 },
  { offset: { x: -shape.halfExtents.x, y: 0, z: 0 }, part: 'body', scale: 0 },
  { offset: { x: 0, y: 0, z: shape.halfExtents.z }, part: 'body', scale: 0 },
  { offset: { x: 0, y: 0, z: -shape.halfExtents.z }, part: 'body', scale: 0 },
  { offset: { x: 0, y: shape.cameraHeight, z: shape.halfExtents.z }, part: 'camera', scale: 0 },
];

/**
 * Find the deepest contact, if any.
 *
 * Terrain is a heightfield so the contact normal comes from the local gradient,
 * which is what lets a drone settle flat on a slope instead of bouncing forever.
 */
export function detectCollision(
  position: Vec3,
  velocity: Vec3,
  orientation: Quat,
  shape: BodyShape,
  world: CollisionWorld,
): Contact | null {
  let deepest: Contact | null = null;

  // --- Terrain -----------------------------------------------------------
  for (const probe of probeOffsets(shape)) {
    const worldOffset = applyQuat(probe.offset, orientation);
    const px = position.x + worldOffset.x;
    const py = position.y + worldOffset.y;
    const pz = position.z + worldOffset.z;
    const reach = probe.part === 'prop' ? probe.scale : 0;
    const ground = world.terrainHeight(px, pz);

    if (py - reach <= ground) {
      const depth = ground - (py - reach);
      const normal = terrainNormal(world, px, pz);
      const approach = -(velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z);
      const candidate: Contact = {
        normal,
        depth,
        approachSpeed: Math.max(approach, 0),
        kind: 'terrain',
        part: probe.part,
        surface: terrainSurface(ground),
        point: { x: px, y: ground, z: pz },
      };
      if (!deepest || candidate.depth > deepest.depth) deepest = candidate;
    }
  }

  // --- Water --------------------------------------------------------------
  if (world.waterHeight !== null && position.y - shape.propRadius <= world.waterHeight) {
    const depth = world.waterHeight - (position.y - shape.propRadius);
    if (!deepest || depth > deepest.depth) {
      deepest = {
        normal: { x: 0, y: 1, z: 0 },
        depth,
        approachSpeed: Math.max(-velocity.y, 0),
        kind: 'water',
        part: 'prop',
        surface: 'water',
        point: { x: position.x, y: world.waterHeight, z: position.z },
      };
    }
  }

  // --- Obstacles ----------------------------------------------------------
  // Each obstacle is approximated as a capped vertical cylinder: a box in plan,
  // flat top. Good enough for the speeds and sizes involved, and it is the shape
  // a pilot actually hits.
  for (const obstacle of world.obstacles) {
    const base = world.terrainHeight(obstacle.position.x, obstacle.position.z);
    const top = base + obstacle.height;
    if (position.y + shape.propRadius < base || position.y - shape.propRadius > top) continue;

    // Rotate the probe into the obstacle's frame.
    const cos = Math.cos(-obstacle.rotation);
    const sin = Math.sin(-obstacle.rotation);
    for (const probe of probeOffsets(shape)) {
      const offset = applyQuat(probe.offset, orientation);
      const dx = position.x + offset.x - obstacle.position.x;
      const dz = position.z + offset.z - obstacle.position.z;
      // Inverse yaw into the obstacle's local frame.
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;

      const px = position.x + offset.x;
      const py = position.y + offset.y;
      const pz = position.z + offset.z;
      const reach = probe.part === 'prop' ? probe.scale : 0;

      const insidePlan = Math.hypot(lx, lz) <= obstacle.radius + reach;
      const insideVert = py + reach >= base && py - reach <= top;
      if (!insidePlan || !insideVert) continue;

      const depth =
        obstacle.radius + reach - Math.hypot(lx, lz) +
        Math.min(Math.abs(py - base), Math.abs(py - top)) * 0.5;

      // Normal from the closest face.
      const outward = dot({ x: lx, y: 0, z: lz }, { x: Math.cos(obstacle.rotation), y: 0, z: Math.sin(obstacle.rotation) });
      const nx = outward > 0 ? Math.cos(obstacle.rotation) : -Math.cos(obstacle.rotation);
      const nz = outward > 0 ? Math.sin(obstacle.rotation) : -Math.sin(obstacle.rotation);
      const topHit = Math.abs(py - top) < Math.abs(py - base);
      const normal: Vec3 = topHit ? { x: 0, y: 1, z: 0 } : { x: nx, y: 0, z: nz };

      const approach = -(velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z);
      const candidate: Contact = {
        normal,
        depth,
        approachSpeed: Math.max(approach, 0),
        kind: 'obstacle',
        part: probe.part,
        obstacleId: obstacle.id,
        surface: surfaceForObstacle(obstacle.materialId),
        point: { x: px, y: py, z: pz },
      };
      if (!deepest || candidate.depth > deepest.depth) deepest = candidate;
    }
  }

  return deepest;
}

function terrainNormal(world: CollisionWorld, x: number, z: number): Vec3 {
  const e = 1.5;
  const dx = (world.terrainHeight(x + e, z) - world.terrainHeight(x - e, z)) / (2 * e);
  const dz = (world.terrainHeight(x, z + e) - world.terrainHeight(x, z - e)) / (2 * e);
  const n = { x: -dx, y: 1, z: -dz };
  const l = length(n);
  return l > 1e-6 ? { x: n.x / l, y: n.y / l, z: n.z / l } : { x: 0, y: 1, z: 0 };
}

function terrainSurface(height: number): Contact['surface'] {
  // Below the base level is the wet valley floor; above it is exposed dirt and rock.
  return height < 18 ? 'grass' : height < 40 ? 'dirt' : 'concrete';
}

function surfaceForObstacle(materialId: string): Contact['surface'] {
  switch (materialId) {
    case 'metal':
      return 'metal';
    case 'concrete':
    case 'brick':
      return 'concrete';
    case 'foliage':
      return 'foliage';
    default:
      return 'dirt';
  }
}

/**
 * Resolve a contact: reflect the velocity with restitution and scrub tangential
 * energy with friction. Quads bounce surprisingly little — most of the energy
 * goes into the frame, which is why they break instead of bouncing.
 */
export function resolveContact(
  velocity: Vec3,
  contact: Contact,
  restitution: number,
  friction: number,
): Vec3 {
  const vn = velocity.x * contact.normal.x + velocity.y * contact.normal.y + velocity.z * contact.normal.z;
  if (vn > 0) return velocity;

  const reflected: Vec3 = {
    x: velocity.x - (1 + restitution) * vn * contact.normal.x,
    y: velocity.y - (1 + restitution) * vn * contact.normal.y,
    z: velocity.z - (1 + restitution) * vn * contact.normal.z,
  };

  // Friction on the tangential component.
  const nrm = contact.normal;
  const tangent: Vec3 = {
    x: reflected.x - (reflected.x * nrm.x + reflected.y * nrm.y + reflected.z * nrm.z) * nrm.x,
    y: reflected.y - (reflected.x * nrm.x + reflected.y * nrm.y + reflected.z * nrm.z) * nrm.y,
    z: reflected.z - (reflected.x * nrm.x + reflected.y * nrm.y + reflected.z * nrm.z) * nrm.z,
  };
  const tLen = length(tangent);
  if (tLen < 1e-6) return reflected;
  const keep = Math.max(0, 1 - friction);
  return {
    x: reflected.x - tangent.x * (1 - keep),
    y: reflected.y - tangent.y * (1 - keep),
    z: reflected.z - tangent.z * (1 - keep),
  };
}
