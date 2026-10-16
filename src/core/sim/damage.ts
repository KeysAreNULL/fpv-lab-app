/**
 * Part damage.
 *
 * FPV damage is not a single health bar. Each failure mode is distinct and
 * pilots recognise them immediately:
 *
 *  - **Props** chip, flex and finally snap. A chipped prop loses a few percent
 *    of thrust, adds drag, and throws a violent vibration that shows up in the
 *    video before it shows up in the handling.
 *  - **Frame** arms bend. A bent arm tilts the thrust vector, so the drone
 *    drifts toward the bent corner and needs constant yaw trim to fly straight.
 *  - **Electronics** (FC/ESC) get knocked out of true. Gyro noise rises, control
 *    authority drops, and the FC may brownout on load spikes.
 *  - **Camera** cracks, gets splashed, or the lens fogs. Each produces a
 *    specific artefact in the video feed rather than a generic "worse picture".
 *
 * Damage is driven by impact energy, which is the honest formulation: a 2 m/s
 * tap into grass is nothing, a 12 m/s hit into concrete ends the flight.
 */

import { clamp, type Vec3 } from '../math/vec3';
import { createRng, type Rng } from '../math/rng';
import type { SimSettings } from './settings';

export type DamageState = 'pristine' | 'scuffed' | 'chipped' | 'bent' | 'broken' | 'dead';

export interface PropDamage {
  /** 0..1, 1 = perfect. */
  condition: number;
  /** Angular position of the worst chip, radians — a bent blade. */
  chipAngleRad: number;
  /** How badly the blade is out of true, 0..1. */
  warp: number;
  state: DamageState;
}

export interface FrameDamage {
  /** 0..1. */
  condition: number;
  /** Yaw misalignment from a bent arm, radians. */
  yawBiasRad: number;
  /** Roll bias, radians. */
  rollBiasRad: number;
  /** Extra drag multiplier from scuffed/deformed arms. */
  dragMultiplier: number;
  state: DamageState;
}

export interface ElectronicsDamage {
  /** 0..1. */
  condition: number;
  /** Gyro noise floor added to the attitude estimate, rad. */
  gyroNoiseRad: number;
  /** Control authority multiplier, 0.5..1. */
  authorityScale: number;
  /** Chance per second of an ESC desync. */
  desyncRate: number;
  state: DamageState;
}

export interface CameraDamage {
  /** 0..1. */
  condition: number;
  /** 0..1 crack artefact intensity. */
  crack: number;
  /** 0..1 dead/stuck pixel density. */
  deadPixels: number;
  /** 0..1 fogging or water on the lens. */
  fog: number;
  /** Effective TVL after damage. */
  effectiveTvl: number;
  state: DamageState;
}

export interface DamageSnapshot {
  frame: FrameDamage;
  props: PropDamage[];
  electronics: ElectronicsDamage;
  camera: CameraDamage;
  /** Combined 0..1, 1 = brand new. */
  overall: number;
  /** Human-readable summary of the worst problem. */
  worstIssue: string;
  /** True when the airframe is too damaged to fly. */
  unflyable: boolean;
}

const NEUTRAL_PROPS: PropDamage = {
  condition: 1,
  chipAngleRad: 0,
  warp: 0,
  state: 'pristine',
};

/** Fresh, undamaged state for all components. */
export function freshDamage(): DamageSnapshot {
  return {
    frame: { condition: 1, yawBiasRad: 0, rollBiasRad: 0, dragMultiplier: 1, state: 'pristine' },
    props: [{ ...NEUTRAL_PROPS }, { ...NEUTRAL_PROPS }, { ...NEUTRAL_PROPS }, { ...NEUTRAL_PROPS }],
    electronics: { condition: 1, gyroNoiseRad: 0, authorityScale: 1, desyncRate: 0, state: 'pristine' },
    camera: { condition: 1, crack: 0, deadPixels: 0, fog: 0, effectiveTvl: 1000, state: 'pristine' },
    overall: 1,
    worstIssue: 'Airframe is as new.',
    unflyable: false,
  };
}

function grade(condition: number): DamageState {
  if (condition > 0.95) return 'pristine';
  if (condition > 0.8) return 'scuffed';
  if (condition > 0.6) return 'chipped';
  if (condition > 0.35) return 'bent';
  if (condition > 0.05) return 'broken';
  return 'dead';
}

/**
 * Kinetic energy of an impact, joules. Uses the translational energy of the
 * airframe plus a rotational term from how fast the props were turning — which
 * is why flipping a quad on the grass at full throttle destroys props that a
 * gentle nose-in would not touch.
 */
export function impactEnergy(
  massKg: number,
  velocity: Vec3,
  propOmega: number,
  propCount: number,
  propInertia: number,
  propRadius: number,
): number {
  const linear = 0.5 * massKg * (velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
  const rotational =
    0.5 * propCount * propInertia * propRadius * propRadius * propOmega * propOmega;
  return linear + rotational;
}

/** How damaging a surface is. Grass absorbs; concrete does not. */
export function surfaceDamping(surface: 'grass' | 'dirt' | 'metal' | 'concrete' | 'water' | 'foliage'): number {
  switch (surface) {
    case 'grass':
      return 0.28;
    case 'dirt':
      return 0.42;
    case 'foliage':
      return 0.2;
    case 'metal':
      return 0.85;
    case 'concrete':
      return 1;
    case 'water':
      return 0.15;
  }
}

/**
 * Accumulates damage over a session. Every method is gated on the matching
 * settings flag so that turning damage off is a genuine no-op.
 */
export class DamageModel {
  private state: DamageSnapshot = freshDamage();
  private readonly rng: Rng;
  private readonly motorCount = 4;

  constructor(seed: number) {
    this.rng = createRng(seed ^ 0x2f6d);
  }

  reset(): void {
    this.state = freshDamage();
  }

  get snapshot(): DamageSnapshot {
    return this.state;
  }

  /** Rebuild a snapshot after props have been destroyed one at a time. */
  private syncProps(): void {
    while (this.state.props.length < this.motorCount) {
      this.state.props.push({ ...NEUTRAL_PROPS });
    }
  }

  /**
   * Apply an impact. `energy` is already the post-damping kinetic energy, so
   * the thresholds below are direct: below ~0.5 J nothing happens, above ~25 J
   * a 5" quad is scrap.
   */
  applyImpact(
    energy: number,
    settings: SimSettings,
    surface: 'grass' | 'dirt' | 'metal' | 'concrete' | 'water' | 'foliage',
    impactNormal: Vec3,
  ): number {
    if (!settings.partsDamage || energy < 0.05) return 0;
    const severity = energy * surfaceDamping(surface);

    // Props take the worst of it: they are the cheapest and most fragile part.
    if (settings.propDamage && severity > 0.08) {
      this.syncProps();
      // Which corner did we hit? The vector from CG to the impact picks the prop.
      const bearing = Math.atan2(impactNormal.x, impactNormal.z);
      const index = Math.floor(((bearing / (Math.PI * 2) + 0.5) % 1) * this.motorCount);
      const affected = this.state.props[index];
      if (affected) {
        const loss = clamp(severity * (0.9 + this.rng.range(-0.15, 0.15)), 0, 0.85);
        affected.condition = clamp(affected.condition - loss, 0, 1);
        if (severity > 0.6) {
          affected.chipAngleRad = this.rng.range(0, Math.PI * 2);
          affected.warp = clamp(affected.warp + severity * 0.25, 0, 1);
        }
        affected.state = grade(affected.condition);
      }
      // Props also all get a little abuse from debris.
      for (let i = 0; i < this.state.props.length; i++) {
        if (i === index) continue;
        const p = this.state.props[i];
        p.condition = clamp(p.condition - severity * 0.12, 0, 1);
        p.state = grade(p.condition);
      }
    }

    // Frame: bends once the energy is well past the prop threshold.
    if (settings.frameDamage && severity > 0.4) {
      const loss = clamp((severity - 0.4) * 0.06, 0, 0.5);
      this.state.frame.condition = clamp(this.state.frame.condition - loss, 0, 1);
      // A bent arm produces a persistent misalignment. Thicker frames resist.
      const bias = clamp((severity - 0.6) * 0.012, 0, 0.09);
      this.state.frame.yawBiasRad += this.rng.range(-bias, bias);
      this.state.frame.rollBiasRad += this.rng.range(-bias * 0.6, bias * 0.6);
      this.state.frame.dragMultiplier = 1 + (1 - this.state.frame.condition) * 0.22;
      this.state.frame.state = grade(this.state.frame.condition);
    }

    // Electronics: only on hard hits, or soft hits on an already-damaged board.
    if (settings.electronicsDamage && severity > 1.2) {
      const loss = clamp((severity - 1.2) * 0.05, 0, 0.6);
      this.state.electronics.condition = clamp(this.state.electronics.condition - loss, 0, 1);
      this.state.electronics.gyroNoiseRad = (1 - this.state.electronics.condition) * 0.035;
      this.state.electronics.authorityScale = 0.6 + this.state.electronics.condition * 0.4;
      this.state.electronics.desyncRate = Math.pow(1 - this.state.electronics.condition, 2.2) * 0.4;
      this.state.electronics.state = grade(this.state.electronics.condition);
    }

    // Camera: the most fragile thing on the airframe after the props.
    if (settings.cameraDamage && severity > 0.5) {
      const loss = clamp((severity - 0.5) * 0.08, 0, 0.75);
      this.state.camera.condition = clamp(this.state.camera.condition - loss, 0, 1);
      if (loss > 0.05) {
        this.state.camera.crack = clamp(this.state.camera.crack + loss * 0.8, 0, 1);
        this.state.camera.deadPixels = clamp(this.state.camera.deadPixels + loss * 0.6, 0, 1);
      }
      this.state.camera.effectiveTvl = 1000 * this.state.camera.condition;
      this.state.camera.state = grade(this.state.camera.condition);
    }

    this.recompute();
    return severity;
  }

  /** Rain and humidity gradually fog the lens and degrade the camera. */
  applyEnvironment(
    dt: number,
    rainMmPerHour: number,
    humidity: number,
    temperatureC: number,
    settings: SimSettings,
  ): void {
    if (!settings.cameraDamage) return;
    const condensationRate = (humidity * 0.02 + rainMmPerHour * 0.004) * dt;
    if (condensationRate > 0) {
      this.state.camera.fog = clamp(this.state.camera.fog + condensationRate, 0, 1);
      // Below the dew point the fog sets hard and stays.
      if (temperatureC < 12) {
        this.state.camera.fog = clamp(this.state.camera.fog + dt * 0.02, 0, 1);
      }
    }
    // Wind and propwash slowly dry the lens again.
    const dryRate = (rainMmPerHour > 1 ? 0.001 : 0.02) * dt;
    if (this.state.camera.fog > 0) {
      this.state.camera.fog = clamp(this.state.camera.fog - dryRate, 0, 1);
    }
    this.state.camera.effectiveTvl = 1000 * this.state.camera.condition * (1 - this.state.camera.fog * 0.55);
  }

  private recompute(): void {
    const s = this.state;
    const worstProp = s.props.reduce((a, p) => Math.min(a, p.condition), 1);
    const worstPropState = s.props.find((p) => p.condition === worstProp)?.state ?? 'pristine';
    s.overall =
      s.frame.condition * 0.3 +
      worstProp * 0.3 +
      s.electronics.condition * 0.25 +
      s.camera.condition * 0.15;

    s.unflyable =
      s.frame.condition < 0.12 ||
      worstProp < 0.05 ||
      s.electronics.condition < 0.08;

    const issues: { level: number; text: string }[] = [
      { level: s.frame.condition, text: frameText(s.frame.state) },
      { level: worstProp, text: `Prop ${worstPropState}` },
      { level: s.electronics.condition, text: electronicsText(s.electronics.state) },
      { level: s.camera.condition, text: cameraText(s.camera.state) },
    ];
    issues.sort((a, b) => a.level - b.level);
    s.worstIssue = issues[0].level > 0.95 ? 'Airframe is as new.' : capitalize(issues[0].text);
  }

  /** Mean prop condition — the thrust multiplier the physics reads. */
  get propHealth(): number {
    const s = this.state;
    if (s.props.length === 0) return 1;
    return s.props.reduce((a, p) => a + p.condition, 0) / s.props.length;
  }

  /** Electronics condition, used for gyro noise and control authority. */
  get electronicsHealth(): number {
    return this.state.electronics.condition;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const frameText = (state: DamageState): string => {
  switch (state) {
    case 'pristine':
      return 'Frame is straight.';
    case 'scuffed':
      return 'Frame arms are scuffed — drag is slightly up.';
    case 'chipped':
      return 'Frame arms are chipped.';
    case 'bent':
      return 'Arms are bent — the drone will not fly straight.';
    case 'broken':
      return 'Arms are broken.';
    case 'dead':
      return 'Airframe is structurally destroyed.';
  }
};

const electronicsText = (state: DamageState): string => {
  switch (state) {
    case 'pristine':
      return 'Flight controller is healthy.';
    case 'scuffed':
      return 'Gyro is noisy.';
    case 'chipped':
      return 'FC has signal noise and reduced authority.';
    case 'bent':
      return 'FC is badly damaged — expect desyncs.';
    case 'broken':
      return 'FC is failing.';
    case 'dead':
      return 'FC is dead.';
  }
};

const cameraText = (state: DamageState): string => {
  switch (state) {
    case 'pristine':
      return 'Camera is clean.';
    case 'scuffed':
      return 'Lens is scratched.';
    case 'chipped':
      return 'Sensor has damage — dead pixels in the image.';
    case 'bent':
      return 'Camera is cracked.';
    case 'broken':
      return 'Camera is heavily damaged.';
    case 'dead':
      return 'Camera is dead.';
  }
};
