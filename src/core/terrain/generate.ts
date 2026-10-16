/**
 * Procedural terrain.
 *
 * The world has two clearly separated regions, which is what makes the flying
 * areas meaningful:
 *
 *  - **Designated flying areas** — hand-shaped, deliberately smooth, and marked
 *    with pads, gates and a launch zone. Terrain is flattened toward a
 *    reference height, obstacles are excluded, and the wind field treats the
 *    ground as smooth. This is where you are meant to fly and where the signal
 *    is clean.
 *  - **Everything outside them** — fully procedural: ridged fbm terrain, a town
 *    cluster, a pylon line, scattered stands of trees and rock outcrops. These
 *    exist for line-of-sight, wind and RF penetration. Obstacles here block
 *    signal, generate turbulence, and can be flown into.
 *
 * Deterministic from a seed string, so the same seed always regenerates the same
 * map for everyone.
 */

import { createRng, hashString } from '../math/rng';
import { Noise2D } from '../math/noise';
import { clamp, smoothstep, type Vec3 } from '../math/vec3';
import type { Material } from '../sim/signal';
import type { ObstacleWindProfile } from '../sim/wind';

export interface TerrainConfig {
  seed: string;
  /** World extent, metres. The map spans −half..+half on x and z. */
  size: number;
  /** Heightfield resolution. */
  resolution: number;
  /** Vertical scale of the procedural relief. */
  amplitude: number;
  /** Vertical offset applied everywhere. */
  baseHeight: number;
  /** How much the designated areas flatten the terrain, 0..1. */
  areaFlattening: number;
}

export const DEFAULT_TERRAIN: TerrainConfig = {
  seed: 'fpv-lab',
  size: 2400,
  resolution: 256,
  amplitude: 70,
  baseHeight: 24,
  areaFlattening: 0.94,
};

export type ObstacleKind =
  | 'building'
  | 'hangar'
  | 'pylon'
  | 'tower'
  | 'tree'
  | 'rock'
  | 'fence'
  | 'gate';

export interface Obstacle {
  id: string;
  kind: ObstacleKind;
  /** Base centre, world frame. */
  position: Vec3;
  /** Radius / half-width, metres. */
  radius: number;
  height: number;
  /** Rotation about Y, radians. */
  rotation: number;
  materialId: Material['id'];
  /** 0..1 how much this blocks RF. */
  rfSolidity: number;
  /** 0..1 how much this blocks and redirects wind. */
  windSolidity: number;
  /** Seeded variation for the mesh, 0..1. */
  variant: number;
}

export interface FlyingArea {
  id: string;
  name: string;
  /** Centre, world frame. */
  center: Vec3;
  /** Radius of the protected zone, metres. */
  radius: number;
  /** Terrain height inside the zone. */
  floorHeight: number;
  kind: 'pad' | 'course' | 'open';
  /** Waypoints for the course, world frame. */
  gates: Vec3[];
}

export interface LaunchPoint {
  id: string;
  /** Human-readable label for the pilot. */
  name: string;
  /** Where the pilot stands. Drives both the wind and the RF geometry. */
  position: Vec3;
  /** Facing direction, radians clockwise from north. */
  headingRad: number;
  /** Terrain height there, metres. */
  groundHeight: number;
  areaId: string;
  /** Clear line of sight into the course, metres. */
  maxRangeM: number;
  /** True if the pilot has to shoot through a building to see the course. */
  hasObstruction: boolean;
}

export interface TerrainSample {
  height: number;
  /** dTerrain/dx and dTerrain/dz — used for slope-aligned landing and lift. */
  gradientX: number;
  gradientZ: number;
  /** True when the point is inside a designated area (smoothed terrain). */
  inFlyingArea: boolean;
  /** Distance to the nearest area edge, metres. */
  areaBlend: number;
}

export class Terrain {
  readonly config: TerrainConfig;
  readonly noise: Noise2D;
  readonly noiseB: Noise2D;
  readonly areas: FlyingArea[] = [];
  readonly obstacles: Obstacle[] = [];
  readonly launchPoints: LaunchPoint[] = [];
  readonly seedNumber: number;

  constructor(config: Partial<TerrainConfig> = {}) {
    this.config = { ...DEFAULT_TERRAIN, ...config };
    this.seedNumber = hashString(this.config.seed);
    this.noise = new Noise2D(this.seedNumber);
    this.noiseB = new Noise2D(this.seedNumber ^ 0x9e3779b9);

    this.buildAreas();
    this.buildObstacles();
    this.buildLaunchPoints();
  }

  /** Raw procedural height before any area flattening, metres. */
  private rawHeight(x: number, z: number): number {
    const { amplitude, size, baseHeight } = this.config;
    const s = 1 / 900;
    const nx = x * s;
    const nz = z * s;

    // Ridged noise gives credible hill crests; fbm gives the rolling base.
    const ridge = this.noise.ridged(nx * 1.6, nz * 1.6, 5) - 0.35;
    const rolling = this.noise.warpedFbm(nx, nz, 0.7, 5);
    // A broad bowl keeps the flying areas in a valley, which is where you would
    // actually pick a field to fly from.
    const radial = Math.hypot(x, z) / size;
    const bowl = -Math.pow(clamp(radial * 2, 0, 1), 2) * amplitude * 0.55;

    return baseHeight + amplitude * (ridge * 0.75 + rolling * 0.45) + bowl;
  }

  /** How much this point is inside a designated area, 0..1. */
  private areaInfluence(x: number, z: number): { blend: number; area: FlyingArea | null } {
    let best = 0;
    let bestArea: FlyingArea | null = null;
    for (const area of this.areas) {
      const d = Math.hypot(x - area.center.x, z - area.center.z);
      // Feather over 60 m so the transition is smooth rather than a step.
      const inside = 1 - smoothstep(area.radius * 0.85, area.radius + 60, d);
      if (inside > best) {
        best = inside;
        bestArea = inside > 0.01 ? area : null;
      }
    }
    return { blend: best, area: bestArea };
  }

  /** Full terrain sample including area flattening. */
  sample(x: number, z: number): TerrainSample {
    const h = this.rawHeight(x, z);
    const { blend, area } = this.areaInfluence(x, z);
    const flatten = this.config.areaFlattening * blend;
    const height = area ? h * (1 - flatten) + area.floorHeight * flatten : h;

    // Gradient by central difference at 2 m — enough resolution for slope logic.
    const e = 2;
    const dx = (this.sampleHeight(x + e, z) - this.sampleHeight(x - e, z)) / (2 * e);
    const dz = (this.sampleHeight(x, z + e) - this.sampleHeight(x, z - e)) / (2 * e);

    return { height, gradientX: dx, gradientZ: dz, inFlyingArea: blend > 0.5, areaBlend: blend };
  }

  /** Height only — the fast path used by the physics loop. */
  sampleHeight(x: number, z: number): number {
    const h = this.rawHeight(x, z);
    const { blend, area } = this.areaInfluence(x, z);
    if (blend <= 0.001) return h;
    const flatten = this.config.areaFlattening * blend;
    return area ? h * (1 - flatten) + area.floorHeight * flatten : h;
  }

  /**
   * Terrain slope projected onto the wind direction — positive means the wind is
   * climbing a slope, which is what produces orographic lift.
   */
  slopeAlongWind(x: number, z: number, windDirRad: number): number {
    const { gradientX, gradientZ } = this.sample(x, z);
    const dirX = Math.sin(windDirRad);
    const dirZ = Math.cos(windDirRad);
    return clamp(gradientX * dirX + gradientZ * dirZ, -1.5, 1.5);
  }

  // -------------------------------------------------------------------------
  // World construction
  // -------------------------------------------------------------------------

  private buildAreas(): void {
    const rng = createRng(this.seedNumber ^ 0x1111);
    const { size } = this.config;

    // A dedicated launch pad, a race course and a long open field.
    this.areas.push({
      id: 'area-launch-pad',
      name: 'Launch Pad',
      center: { x: -size * 0.22, y: 0, z: size * 0.22 },
      radius: 130,
      floorHeight: this.rawHeight(-size * 0.22, size * 0.22),
      kind: 'pad',
      gates: [],
    });

    const courseCenter = { x: size * 0.08, y: 0, z: -size * 0.05 };
    const gateCount = 6;
    const courseRadius = 110;
    const gates: Vec3[] = [];
    for (let i = 0; i < gateCount; i++) {
      const angle = (i / gateCount) * Math.PI * 2 + rng.range(-0.15, 0.15);
      const radius = courseRadius * rng.range(0.65, 1.15);
      const gx = courseCenter.x + Math.cos(angle) * radius;
      const gz = courseCenter.z + Math.sin(angle) * radius;
      gates.push({
        x: gx,
        y: this.rawHeight(gx, gz) + rng.range(6, 22),
        z: gz,
      });
    }
    this.areas.push({
      id: 'area-race-course',
      name: 'Race Course',
      center: { ...courseCenter },
      radius: 210,
      floorHeight: this.rawHeight(courseCenter.x, courseCenter.z),
      kind: 'course',
      gates,
    });

    this.areas.push({
      id: 'area-open-field',
      name: 'Open Field',
      center: { x: -size * 0.05, y: 0, z: -size * 0.3 },
      radius: 320,
      floorHeight: this.rawHeight(-size * 0.05, -size * 0.3),
      kind: 'open',
      gates: [],
    });
  }

  private buildObstacles(): void {
    const rng = createRng(this.seedNumber ^ 0x2222);
    const { size } = this.config;
    const half = size / 2;

    // --- Town cluster: a dense block of buildings -----------------------------
    // Deliberately placed outside every designated area so it only matters for
    // signal, wind and the occasional stupid line.
    const townCenter = { x: size * 0.34, y: 0, z: size * 0.26 };
    const blocksX = 5;
    const blocksZ = 4;
    const spacing = 62;
    for (let bx = 0; bx < blocksX; bx++) {
      for (let bz = 0; bz < blocksZ; bz++) {
        if (rng.chance(0.18)) continue;
        const x = townCenter.x + (bx - blocksX / 2) * spacing + rng.range(-6, 6);
        const z = townCenter.z + (bz - blocksZ / 2) * spacing + rng.range(-6, 6);
        if (this.insideAnyArea(x, z, 90)) continue;
        const tall = rng.chance(0.25);
        const height = tall ? rng.range(24, 46) : rng.range(7, 16);
        this.obstacles.push({
          id: `building-${bx}-${bz}`,
          kind: 'building',
          position: { x, y: this.rawHeight(x, z), z },
          radius: rng.range(13, 22),
          height,
          rotation: rng.range(-0.12, 0.12),
          materialId: tall ? 'concrete' : rng.chance(0.5) ? 'brick' : 'drywall',
          rfSolidity: tall ? 0.95 : 0.7,
          windSolidity: tall ? 0.9 : 0.6,
          variant: rng.next(),
        });
      }
    }

    // --- Hangars near the open field -----------------------------------------
    for (let i = 0; i < 3; i++) {
      const x = -size * 0.22 + i * 78 + rng.range(-14, 14);
      const z = size * 0.36 + rng.range(-18, 18);
      if (this.insideAnyArea(x, z, 60)) continue;
      this.obstacles.push({
        id: `hangar-${i}`,
        kind: 'hangar',
        position: { x, y: this.rawHeight(x, z), z },
        radius: rng.range(26, 36),
        height: rng.range(11, 16),
        rotation: rng.range(-0.3, 0.3),
        materialId: 'metal',
        rfSolidity: 0.85,
        windSolidity: 0.55,
        variant: rng.next(),
      });
    }

    // --- Pylon line marching across the map ---------------------------------
    // The classic FPV obstacle: tall, thin, and lethal to both signal and wind.
    const pylonCount = 7;
    const pylonStart = { x: -half * 0.75, z: -half * 0.1 };
    for (let i = 0; i < pylonCount; i++) {
      const t = i / (pylonCount - 1);
      const x = pylonStart.x + t * size * 1.1;
      const z = pylonStart.z + Math.sin(t * 3.1) * 130 + rng.range(-22, 22);
      this.obstacles.push({
        id: `pylon-${i}`,
        kind: 'pylon',
        position: { x, y: this.rawHeight(x, z), z },
        radius: 6,
        height: rng.range(38, 52),
        rotation: rng.range(0, Math.PI),
        materialId: 'metal',
        rfSolidity: 0.8,
        windSolidity: 0.5,
        variant: rng.next(),
      });
    }

    // --- Communication tower --------------------------------------------------
    {
      const x = size * 0.4;
      const z = -size * 0.3;
      if (!this.insideAnyArea(x, z, 70)) {
        this.obstacles.push({
          id: 'tower-comms',
          kind: 'tower',
          position: { x, y: this.rawHeight(x, z), z },
          radius: 9,
          height: 78,
          rotation: 0,
          materialId: 'metal',
          rfSolidity: 0.65,
          windSolidity: 0.8,
          variant: rng.next(),
        });
      }
    }

    // --- Rock outcrops ---------------------------------------------------------
    for (let i = 0; i < 28; i++) {
      const x = rng.range(-half, half);
      const z = rng.range(-half, half);
      if (this.insideAnyArea(x, z, 40)) continue;
      const radius = rng.range(8, 30);
      this.obstacles.push({
        id: `rock-${i}`,
        kind: 'rock',
        position: { x, y: this.rawHeight(x, z), z },
        radius,
        height: radius * rng.range(0.5, 1.4),
        rotation: rng.range(0, Math.PI),
        materialId: 'earth',
        rfSolidity: 0.4,
        windSolidity: 0.45,
        variant: rng.next(),
      });
    }

    // --- Tree stands -----------------------------------------------------------
    for (let i = 0; i < 34; i++) {
      const x = rng.range(-half, half);
      const z = rng.range(-half, half);
      if (this.insideAnyArea(x, z, 50)) continue;
      const radius = rng.range(6, 16);
      const height = rng.range(9, 20);
      this.obstacles.push({
        id: `tree-${i}`,
        kind: 'tree',
        position: { x, y: this.rawHeight(x, z), z },
        radius,
        height,
        rotation: rng.range(0, Math.PI),
        materialId: 'foliage',
        // Foliage barely stops RF but scatters it heavily, which makes a wood a
        // surprisingly good place to lose your video.
        rfSolidity: 0.25,
        windSolidity: 0.35,
        variant: rng.next(),
      });
    }

    // --- Chain-link fence around the town --------------------------------------
    const fenceSegments = 10;
    for (let i = 0; i < fenceSegments; i++) {
      const angle = (i / fenceSegments) * Math.PI * 2;
      const x = townCenter.x + Math.cos(angle) * 230;
      const z = townCenter.z + Math.sin(angle) * 230;
      if (this.insideAnyArea(x, z, 40)) continue;
      this.obstacles.push({
        id: `fence-${i}`,
        kind: 'fence',
        position: { x, y: this.rawHeight(x, z), z },
        radius: 40,
        height: 3,
        rotation: angle + Math.PI / 2,
        materialId: 'metal',
        rfSolidity: 0.35,
        windSolidity: 0.12,
        variant: rng.next(),
      });
    }

    // --- Course gates as physical obstacles ------------------------------------
    const course = this.areas.find((a) => a.kind === 'course');
    course?.gates.forEach((gate, i) => {
      this.obstacles.push({
        id: `gate-${i}`,
        kind: 'gate',
        position: { ...gate },
        radius: 5,
        height: 7,
        rotation: (i / course.gates.length) * Math.PI,
        materialId: 'plastic',
        rfSolidity: 0.3,
        windSolidity: 0.35,
        variant: rng.next(),
      });
    });
  }
  /**
   * Pilot stand positions. The player picks one of these, and that choice is
   * what determines the RF geometry and the local wind - stand behind the
   * pylons and the video dies; stand at the pad and it does not.
   *
   * Each curated stand names what it is looking at, so its heading is derived
   * from the geometry rather than guessed. That keeps the line-of-sight flag
   * honest: if a stand claims the hangar row is in the way, it is.
   */
  private buildLaunchPoints(): void {
    const rng = createRng(this.seedNumber ^ 0x3333);
    const { size } = this.config;
    const course = this.areas.find((a) => a.kind === 'course');
    const courseCenter = course?.center ?? { x: 0, y: 0, z: 0 };

    // x/z are fractions of the world size; tx/tz is the point being looked at.
    const curated: { x: number; z: number; tx: number; tz: number; name: string; area: string }[] = [
      { x: -0.24, z: 0.24, tx: 0.08, tz: -0.05, name: 'Pad - clear', area: 'area-launch-pad' },
      { x: -0.22, z: 0.34, tx: 0.08, tz: -0.05, name: 'Pad - behind the hangars', area: 'area-launch-pad' },
      { x: -0.34, z: 0.2, tx: 0.08, tz: -0.05, name: 'Pad - ridge side', area: 'area-launch-pad' },
      { x: 0.06, z: -0.28, tx: 0.08, tz: -0.05, name: 'Course - north side', area: 'area-race-course' },
      { x: 0.2, z: 0.14, tx: 0.08, tz: -0.05, name: 'Course - town side', area: 'area-race-course' },
      { x: -0.06, z: -0.3, tx: 0.08, tz: -0.05, name: 'Field - south', area: 'area-open-field' },
      { x: 0.04, z: -0.38, tx: 0.08, tz: -0.05, name: 'Field - downrange', area: 'area-open-field' },
      { x: 0.42, z: 0.34, tx: 0.08, tz: -0.05, name: 'Town - through the buildings', area: 'none' },
      { x: -0.5, z: -0.18, tx: 0.08, tz: -0.05, name: 'Pylons - far side', area: 'none' },
    ];

    for (const c of curated) {
      const x = c.x * size;
      const z = c.z * size;
      const ground = this.sampleHeight(x, z);
      // Compass bearing from (x, z) toward the target: 0 = north (-z).
      const headingRad = Math.atan2(c.tx * size - x, -(c.tz * size - z));
      const distanceToCourse = Math.hypot(x - courseCenter.x, z - courseCenter.z);

      this.launchPoints.push({
        id: `stand-${this.launchPoints.length}`,
        name: c.name,
        position: { x, y: ground, z },
        headingRad,
        groundHeight: ground,
        areaId: c.area,
        maxRangeM: distanceToCourse * 1.8,
        hasObstruction: this.obstructionsToward(x, z, headingRad, 200),
      });
    }

    // Plus scattered spots on high ground, which give the best long-range links.
    for (let i = 0; i < 8; i++) {
      let best = { x: 0, z: 0, h: -Infinity };
      for (let attempt = 0; attempt < 12; attempt++) {
        const x = rng.range(-size * 0.45, size * 0.45);
        const z = rng.range(-size * 0.45, size * 0.45);
        if (this.insideAnyArea(x, z, 80)) continue;
        const h = this.sampleHeight(x, z);
        if (h > best.h) best = { x, z, h };
      }
      if (best.h === -Infinity) continue;
      const headingRad = Math.atan2(courseCenter.x - best.x, -(courseCenter.z - best.z));
      this.launchPoints.push({
        id: `stand-hill-${i}`,
        name: `Ridge ${i + 1}`,
        position: { x: best.x, y: best.h, z: best.z },
        headingRad,
        groundHeight: best.h,
        areaId: 'none',
        maxRangeM: 2200,
        hasObstruction: this.obstructionsToward(best.x, best.z, headingRad, 300),
      });
    }
  }

  /** True when a point falls inside any designated area (with extra padding). */
  insideAnyArea(x: number, z: number, padding = 0): boolean {
    for (const area of this.areas) {
      if (Math.hypot(x - area.center.x, z - area.center.z) < area.radius + padding) return true;
    }
    return false;
  }

  /** True when any obstacle sits within `range` metres along `bearingRad`. */
  obstructionsToward(x: number, z: number, bearingRad: number, range: number): boolean {
    const ux = Math.sin(bearingRad);
    const uz = -Math.cos(bearingRad);
    return this.obstacles.some((o) => {
      const relX = o.position.x - x;
      const relZ = o.position.z - z;
      const along = relX * ux + relZ * uz;
      if (along < 6 || along > range) return false;
      const lateral = Math.abs(relX * -uz + relZ * ux);
      return lateral < o.radius * 0.9;
    });
  }

  /** Wind-blocking profile for every obstacle. */
  windProfiles(): ObstacleWindProfile[] {
    return this.obstacles.map((o) => ({
      center: o.position,
      radius: Math.max(o.radius, 4),
      height: o.height,
      solidity: o.windSolidity,
    }));
  }

  /** Every obstacle as an RF obstruction, expanded into a segment. */
  /**
   * Obstacles near the line between two points, as thin RF-obstructing segments.
   * Returns the segment the ray actually passes through so the signal model can
   * decide whether it is inside the Fresnel zone.
   */
  obstructionsBetween(from: Vec3, to: Vec3): {
    start: Vec3;
    end: Vec3;
    materialId: Material['id'];
    thickness: number;
  }[] {
    const out: { start: Vec3; end: Vec3; materialId: Material['id']; thickness: number }[] = [];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lengthM = Math.hypot(dx, dz);
    if (lengthM < 1) return out;
    const ux = dx / lengthM;
    const uz = dz / lengthM;

    for (const o of this.obstacles) {
      const relX = o.position.x - from.x;
      const relZ = o.position.z - from.z;
      const along = relX * ux + relZ * uz;
      if (along < 0 || along > lengthM) continue;
      const lateral = Math.abs(relX * -uz + relZ * ux);
      if (lateral > o.radius) continue;

      // The ray intersects the obstacle's footprint between these two heights.
      const ground = this.sampleHeight(o.position.x, o.position.z);
      const base = { x: o.position.x, y: ground, z: o.position.z };
      out.push({
        start: base,
        end: { x: o.position.x, y: ground + o.height, z: o.position.z },
        materialId: o.materialId,
        thickness: Math.max(o.radius * 0.25, 0.2),
      });
    }
    return out;
  }

  /**
   * How far the straight line between two points sits above the terrain.
   * Negative means the terrain cuts through the link.
   */
  terrainClearance(from: Vec3, to: Vec3, samples = 12): number {
    let worst = Infinity;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      const y = from.y + (to.y - from.y) * t;
      const ground = this.sampleHeight(x, z);
      worst = Math.min(worst, y - ground);
    }
    return worst === Infinity ? 0 : worst;
  }

  /** Everything needed for collision against the static world. */
  get collidable(): readonly Obstacle[] {
    return this.obstacles;
  }
}
