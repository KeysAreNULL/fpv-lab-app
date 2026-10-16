/**
 * Wind field. Three layers, all of which pilots actually feel:
 *
 *  1. Boundary layer — wind speed grows with altitude above ground, reaching
 *     the gradient wind near the ridge top. This is why ridge lift exists and
 *     why the air near a building is always weaker than the air above it.
 *  2. Obstacle effects — buildings, pylons and trees create real turbulence
 *     downstream (lee-side rotor), and a vertical updraft on the windward face.
 *     Flying behind a building on a windy day is a genuinely different
 *     experience from flying in front of it.
 *  3. Gusts — two time scales of fbm: a slow wander plus the sharp, irregular
 *     edges that make turbulence feel like turbulence rather than a sine wave.
 *
 * Everything is a pure function of (position, time, seed) so replays reproduce.
 */

import { clamp, smoothstep, type Vec3 } from '../math/vec3';
import { fbm1 } from '../math/noise';

export interface ObstacleWindProfile {
  /** Centre, world frame. */
  center: Vec3;
  /** Radius of the wind-affected wake, metres. */
  radius: number;
  /** Height above its own centre, metres. */
  height: number;
  /** How solid it is to the wind, 0..1. A wall is 1; a tree line is 0.35. */
  solidity: number;
}

export interface WindSettings {
  /** Gradient wind speed at the reference altitude, m/s. */
  speed: number;
  /** Direction the wind blows TOWARD, radians clockwise from north. */
  directionRad: number;
  /** Standard atmospheric stability, 0 = very unstable, 1 = very stable. */
  stability: number;
  /** Gust intensity multiplier. */
  gustiness: number;
  /** Reference altitude for the gradient wind, m. */
  referenceHeightM: number;
  /** Obstacle roughness length scale, 0 = smooth, 1 = rough terrain. */
  roughness: number;
}

export const DEFAULT_WIND: WindSettings = {
  speed: 5,
  directionRad: Math.PI * 0.25,
  stability: 0.5,
  gustiness: 0.35,
  referenceHeightM: 120,
  roughness: 0.5,
};

export interface WindSample {
  /** Wind velocity at this point, m/s, world frame. */
  velocity: Vec3;
  /** Gust component, m/s. */
  gust: Vec3;
  /** Turbulent fluctuation magnitude, m/s. */
  turbulence: number;
  /** Vertical component from terrain/obstacle deflection, m/s. */
  updraft: number;
  /** 0..1 shear coefficient at this altitude. */
  shear: number;
}

export class WindField {
  settings: WindSettings;
  private obstacles: ObstacleWindProfile[] = [];
  private readonly seed: number;

  /** Injected by the world once terrain exists, keeping this module terrain-agnostic. */
  heightProvider: ((x: number, z: number) => number) | null = null;

  constructor(seed: number, settings: WindSettings = DEFAULT_WIND) {
    this.seed = seed;
    this.settings = { ...settings };
  }

  setObstacles(obstacles: readonly ObstacleWindProfile[]): void {
    this.obstacles = [...obstacles];
  }

  /**
   * Power-law boundary layer: u(z) = u_ref · (z / z_ref)^α.
   *
   * α is the surface roughness exponent: 0.1 over water, ~0.16 over open
   * farmland, 0.33 over forest. This is the standard atmospheric form and it is
   * what produces usable ridge lift on a hillside.
   */
  private shearFactor(heightAgl: number): { factor: number; shear: number } {
    const { roughness, stability, referenceHeightM } = this.settings;
    const alpha = (0.1 + roughness * 0.23) * (0.85 + stability * 0.35);
    const z = Math.max(heightAgl, 0.5);
    const factor = clamp(Math.pow(z / referenceHeightM, alpha), 0, 2.2);
    return { factor, shear: clamp(factor, 0, 1) };
  }

  /** Base direction vector the wind blows toward (x = east, z = south). */
  private baseVector(): Vec3 {
    const { directionRad } = this.settings;
    return { x: Math.sin(directionRad), y: 0, z: Math.cos(directionRad) };
  }

  /**
   * Gust envelope. Two fbm time scales: a slow wander for the overall drift and
   * a fast one for the sharp edges. Stable air gusts less and more slowly.
   */
  private gust(time: number, stability: number): number {
    const { gustiness } = this.settings;
    const mean = fbm1(time * 0.17, 3, this.seed);
    const fine = fbm1(time * 1.9, 4, this.seed + 313);
    return (mean * 0.7 + fine * 0.3) * gustiness * (1.25 - stability * 0.5);
  }

  /**
   * Sample the wind at a world position.
   * @param terrainSlope local terrain gradient projected onto the wind
   *   direction (rise/run). Positive means wind climbing a slope = lift.
   */
  sample(position: Vec3, time: number, terrainSlope: number): WindSample {
    const { speed, stability } = this.settings;
    const heightAgl = Math.max(position.y - this.groundHeight(position), 0);
    const { factor, shear } = this.shearFactor(heightAgl);
    const dir = this.baseVector();

    // --- Orographic lift --------------------------------------------------
    // Air forced up a slope rises at roughly the wind speed times the slope.
    // Real ridge lift tops out around 0.6 × wind speed.
    let updraft = clamp(speed * factor * terrainSlope * 0.6, -speed * 1.2, speed * 0.9);

    // --- Gusts ------------------------------------------------------------
    const gust = this.gust(time, stability) * (1 + stability * 0.35);
    let turbulence = Math.abs(gust) * 0.6;

    // --- Obstacle interaction --------------------------------------------
    for (const o of this.obstacles) {
      const dx = position.x - o.center.x;
      const dz = position.z - o.center.z;
      if (Math.hypot(dx, dz) > o.radius * 3.5) continue;
      // Only obstacles reaching above the drone affect it.
      if (position.y > o.center.y + o.height) continue;

      // Decompose the offset into along-wind and cross-wind components.
      const along = dx * dir.x + dz * dir.z;
      const crosswind = dx * -dir.z + dz * dir.x;
      const wakeWidth = o.radius * 2.2;

      if (along > 0 && along < wakeWidth * 2.5 && Math.abs(crosswind) < wakeWidth) {
        // Lee side: decaying, noisy rotor.
        const decay = Math.exp(-along / wakeWidth);
        const lateral = Math.exp(-(crosswind * crosswind) / (wakeWidth * wakeWidth * 0.5));
        const swirl = fbm1(time * 2.4 + along * 0.4 + this.seed, 3, this.seed + 71);
        const strength = o.solidity * speed * factor * decay * lateral;
        updraft += swirl * strength * 0.55 - strength * 0.35;
        turbulence += strength * 0.8;
        if (along > wakeWidth * 0.5) updraft -= strength * 0.45;
      } else if (Math.abs(crosswind) < o.radius * 1.6 && along > -o.radius * 2 && along < 0) {
        // Windward face: flow deflects upward and accelerates over the top.
        const approach = smoothstep(o.radius * 2, 0, -along);
        updraft += o.solidity * speed * factor * approach * 0.5;
        turbulence += o.solidity * speed * approach * 0.18;
      }
    }

    // --- Surface roughness ------------------------------------------------
    const roughnessTurb = this.settings.roughness * speed * factor * 0.22;
    turbulence += roughnessTurb * (0.5 + 0.5 * fbm1(time * 3.1 + position.x * 0.02, 3, this.seed + 907));

    // Roughness also slows the near-surface mean wind slightly.
    const speedScale = 1 - this.settings.roughness * 0.08 * (1 - clamp(heightAgl / 120, 0, 1));

    return {
      velocity: {
        x: dir.x * speed * factor * speedScale,
        y: updraft,
        z: dir.z * speed * factor * speedScale,
      },
      gust: { x: dir.x * gust, y: gust * 0.12, z: dir.z * gust },
      turbulence,
      updraft,
      shear,
    };
  }

  groundHeight(position: Vec3): number {
    return this.heightProvider ? this.heightProvider(position.x, position.z) : 0;
  }
}
