/**
 * The world. Owns the fixed-step simulation loop and orchestrates every system.
 *
 * Rules this module enforces (see AGENTS.md §6):
 *  - Physics always advances at PHYSICS_DT. Frame time is converted into a whole
 *    number of substeps and clamped, so a hitch never changes the dynamics.
 *  - Every optional system reads its flag first and early-returns, leaving its
 *    snapshot fields at neutral defaults. Turning a system off must be a no-op.
 */

import { RAD2DEG, GRAVITY, airDensity } from '../constants';
import { eulerToQuat } from '../math/quat';
import { resolveBuild, type ResolvedBuild } from '../build/resolve';
import { canArm } from '../build/rules';
import type { BuildSpec } from '../parts/presets';
import {
  PHYSICS_DT,
  Quadrotor,
  ZERO_INPUT,
  type ControlInput,
} from '../physics/quadrotor';
import { Terrain, DEFAULT_TERRAIN, type LaunchPoint, type TerrainConfig } from '../terrain/generate';
import { DEFAULT_SETTINGS, type SimSettings } from './settings';
import { DEFAULT_WIND, WindField, type WindSettings } from './wind';
import { Weather, DEFAULT_WEATHER, type WeatherSettings, type WeatherSnapshot } from './weather';
import { SignalModel, type SignalSnapshot } from './signal';
import { DamageModel, impactEnergy, type DamageSnapshot } from './damage';
import {
  detectCollision,
  resolveContact,
  type BodyShape,
  type Contact,
} from './collision';
import type { Vec3 } from '../math/vec3';
import type { TuningState } from '../tuning/tuner';

export interface WorldConfig {
  seed: string;
  terrain: Partial<TerrainConfig>;
  weather: WeatherSettings;
  wind: WindSettings;
}

/** Maximum sim seconds allowed in one frame, to stop a death spiral. */
const MAX_FRAME_TIME = 0.1;

export type FlightPhase = 'disarmed' | 'armed' | 'flying' | 'crashed';

export interface WorldSnapshot {
  phase: FlightPhase;
  time: number;
  /** Simulated seconds since arming. */
  flightTime: number;
  armed: boolean;

  position: Vec3;
  velocity: Vec3;
  speed: number;
  heightAgl: number;
  altitudeMsl: number;
  /** Attitude in degrees, for the HUD. */
  attitudeDeg: { pitch: number; roll: number; yaw: number };

  thrustN: number;
  auwKg: number;
  /** Actual thrust-to-weight, computed live. */
  thrustToWeight: number;
  motorRpm: readonly number[];
  motorThrottle: readonly number[];

  battery: {
    soc: number;
    voltage: number;
    cellVoltage: number;
    currentAmps: number;
    powerWatts: number;
    temperatureC: number;
    remainingSeconds: number;
    brownout: boolean;
    health: number;
  };

  signal: SignalSnapshot;
  damage: DamageSnapshot;
  weather: WeatherSnapshot;
  wind: {
    speed: number;
    directionDeg: number;
    gustSpeed: number;
    turbulence: number;
    updraft: number;
    shear: number;
  };

  contact: Contact | null;
  crashes: number;
  /** Distance flown this session, metres. */
  distanceFlownM: number;
  /** Top speed this session, m/s. */
  maxSpeed: number;
  /** Prop vibration from a damaged or out-of-balance prop set, 0..1. */
  vibration: number;
  /** Total control authority after damage and failsafe, 0..1. */
  controlAuthority: number;
}

export class World {
  readonly terrain: Terrain;
  readonly wind: WindField;
  readonly weather: Weather;
  readonly signal: SignalModel;
  readonly damage: DamageModel;
  quad: Quadrotor;
  build: ResolvedBuild;
  settings: SimSettings;
  tune: TuningState;
  input: ControlInput = { ...ZERO_INPUT };

  /** Pilot position — set by choosing a launch point. */
  pilotPosition: Vec3 = { x: 0, y: 0, z: 0 };
  pilotLaunchPointId: string | null = null;

  private time = 0;
  private flightTime = 0;
  private accumulator = 0;
  /** Flight phase. Public because the UI needs it to label the arm button. */
  phase: FlightPhase = 'disarmed';
  private crashes = 0;
  private distanceFlown = 0;
  private maxSpeed = 0;
  private lastContact: Contact | null = null;
  private lastAuthority = 1;
  /** Edge-trigger latch so holding the arm switch toggles once, not every frame. */
  armLatch = false;
  private readonly bodyShape: BodyShape;
  private readonly seedNumber: number;

  constructor(
    spec: BuildSpec,
    config: Partial<WorldConfig> = {},
    settings: SimSettings = DEFAULT_SETTINGS,
  ) {
    const seed = config.seed ?? 'fpv-lab';
    this.seedNumber = seed.length ? Math.abs(hash(seed)) : 1;
    this.terrain = new Terrain({ ...DEFAULT_TERRAIN, ...config.terrain, seed });
    this.wind = new WindField(this.seedNumber, config.wind ?? DEFAULT_WIND);
    this.weather = new Weather(config.weather ?? DEFAULT_WEATHER);
    this.signal = new SignalModel(this.seedNumber);
    this.damage = new DamageModel(this.seedNumber);
    this.settings = settings;

    this.wind.heightProvider = (x, z) => this.terrain.sampleHeight(x, z);
    this.wind.setObstacles(this.terrain.windProfiles());

    this.build = resolveBuild(spec);
    this.quad = new Quadrotor(this.build, this.weather.weather.temperatureC);
    this.tune = createDefaultTune(this.build);
    this.bodyShape = this.computeBodyShape(this.build);

    const first = this.terrain.launchPoints[0];
    if (first) this.setPilotPosition(first);
    // The drone launches from where the pilot is standing, so start it there
    // rather than at the world origin.
    this.reset();
  }

  private computeBodyShape(build: ResolvedBuild): BodyShape {
    const radius = build.propModel.diameterM / 2;
    return {
      propRadius: radius,
      halfExtents: {
        x: build.armM + radius * 0.25,
        y: Math.max(0.02, build.propModel.diameterM * 0.12),
        z: build.armM + radius * 0.25,
      },
      cameraHeight: 0.02,
      propHeight: radius * 0.12,
    };
  }

  /** Swap the build in place, keeping position, tuning and damage. */
  setBuild(spec: BuildSpec): void {
    this.build = resolveBuild(spec);
    this.quad = new Quadrotor(this.build, this.weather.weather.temperatureC);
    this.quad.state.position = { ...this.quad.state.position };
    this.bodyShape.propRadius = this.build.propModel.diameterM / 2;
    this.tune = retune(this.tune, this.build);
  }

  setSettings(settings: SimSettings): void {
    this.settings = settings;
    if (!settings.partsDamage) this.damage.reset();
  }

  /** Move the pilot to a launch point. This is what changes the RF geometry. */
  setPilotPosition(point: LaunchPoint): void {
    this.pilotPosition = { ...point.position };
    this.pilotLaunchPointId = point.id;
    this.refreshObstructions();
  }
  /** Recompute the obstruction list for the current pilot position. */
  private refreshObstructions(): void {
    if (!this.settings.signalStrength || !this.settings.rfPenetration) {
      this.signal.obstructions = [];
      return;
    }
    this.signal.obstructions = this.terrain.obstructionsBetween(this.pilotPosition, this.quad.state.position);
  }

  arm(): void {
    if (!canArm(this.build.spec)) return;
    if (this.phase === 'flying') return;
    this.phase = 'armed';
    this.flightTime = 0;
  }

  disarm(): void {
    this.phase = 'disarmed';
    this.input = { ...ZERO_INPUT };
  }

  toggleArm(): void {
    if (this.phase === 'flying' || this.phase === 'armed') this.disarm();
    else this.arm();
  }

  reset(): void {
    this.quad.reset({
      x: this.pilotPosition.x,
      y: this.pilotPosition.y + 0.3,
      z: this.pilotPosition.z + 1.2,
    });
    this.damage.reset();
    this.crashes = 0;
    this.distanceFlown = 0;
    this.maxSpeed = 0;
    this.flightTime = 0;
    this.phase = 'disarmed';
    this.refreshObstructions();
  }

  /**
   * Advance the simulation by `frameSeconds` of wall clock.
   * Returns the substeps actually taken.
   */
  step(frameSeconds: number, input: ControlInput): number {
    this.input = input;
    const clamped = Math.min(frameSeconds, MAX_FRAME_TIME);
    this.accumulator += clamped;

    let substeps = 0;
    while (this.accumulator >= PHYSICS_DT && substeps < 400) {
      this.substep(PHYSICS_DT);
      this.accumulator -= PHYSICS_DT;
      substeps++;
    }
    if (substeps >= 400) this.accumulator = 0;

    this.refreshObstructions();
    this.updateNonPhysics(frameSeconds);
    return substeps;
  }

  /** One fixed substep of the rigid-body + electrical simulation. */
  private substep(dt: number): void {
    this.time += dt;
    if (this.phase === 'armed' && this.input.throttle > 0.02) this.phase = 'flying';
    if (this.phase === 'flying') this.flightTime += dt;

    // A disarmed quad sits on its skids. Without this it free-falls into the
    // ground and the camera ends up underneath the terrain.
    if (this.phase !== 'flying') {
      this.restOnGround(dt);
      return;
    }

    const env = this.environment();
    const authority = this.controlAuthority();
    this.lastAuthority = authority;

    this.quad.state.propHealth = this.settings.partsDamage ? this.damage.propHealth : 1;
    this.quad.state.motorHealth = this.settings.partsDamage ? this.damage.electronicsHealth : 1;
    this.quad.state.gyroNoiseRad = this.settings.partsDamage
      ? this.damage.snapshot.electronics.gyroNoiseRad
      : 0;

    this.quad.step(dt, this.input, env, this.tune, authority);
    this.handleCollisions();
    this.applyFrameBias(dt);
  }

  /**
   * Disarmed behaviour: settle the airframe onto the terrain, level it out and
   * spin the motors down. This is what the pilot sees on the bench.
   */
  private restOnGround(dt: number): void {
    const state = this.quad.state;
    const ground = this.terrain.sampleHeight(state.position.x, state.position.z);
    // Props are the lowest point, so the CG rests one prop-radius above ground
    // — plus a little for the camera stack.
    const clearance = this.build.propModel.diameterM * 0.5 + 0.05;

    if (state.position.y <= ground + clearance) {
      // On the ground: hold it there and level the attitude.
      state.position.y = ground + clearance;
      state.velocity.x *= Math.max(0, 1 - dt * 8);
      state.velocity.z *= Math.max(0, 1 - dt * 8);
      state.velocity.y = 0;
      state.angularVelocity.x *= Math.max(0, 1 - dt * 6);
      state.angularVelocity.y *= Math.max(0, 1 - dt * 6);
      state.angularVelocity.z *= Math.max(0, 1 - dt * 6);
      // Level the airframe with the terrain slope.
      const slope = this.terrain.slopeAlongWind(
        state.position.x,
        state.position.z,
        0,
      );
      const level = eulerToQuat(Math.atan(slope) * 0.5, 0, 0);
      state.orientation = level;
    } else {
      // Lifted but not flying (e.g. dropped): still no thrust.
      state.velocity.y -= GRAVITY * dt;
      state.position.y += state.velocity.y * dt;
      if (state.position.y < ground + clearance) {
        state.position.y = ground + clearance;
        state.velocity.y = 0;
      }
    }
  }

  /** Everything the physics needs about the environment at the drone. */
  private environment(): { rho: number; wind: Vec3; groundHeight: number } {
    const position = this.quad.state.position;
    const ground = this.terrain.sampleHeight(position.x, position.z);
    const rho = this.settings.airDensity
      ? airDensity(position.y, this.weather.weather.temperatureC)
      : 1.225;

    if (!this.settings.weather) {
      return { rho, wind: { x: 0, y: 0, z: 0 }, groundHeight: ground };
    }

    const slope = this.terrain.slopeAlongWind(
      position.x,
      position.z,
      this.wind.settings.directionRad,
    );
    const sample = this.wind.sample(position, this.time, slope);
    return {
      rho,
      wind: {
        x: sample.velocity.x + sample.gust.x,
        y: sample.velocity.y + sample.gust.y,
        z: sample.velocity.z + sample.gust.z,
      },
      groundHeight: ground,
    };
  }

  /**
   * Control authority. Damage reduces it, a weak link forces failsafe behaviour,
   * and a frame with bent arms biases the sticks so it drifts.
   */
  private controlAuthority(): number {
    let authority = this.settings.partsDamage ? this.damage.snapshot.electronics.authorityScale : 1;
    if (this.settings.signalStrength && this.settings.radioSignal) {
      const state = this.snapshot().signal.control.state;
      if (state === 'critical') authority *= 0.65;
      if (state === 'failsafe' && this.settings.failsafe) authority *= 0.25;
    }
    return clamp(authority, 0.1, 1);
  }

  /** Bent arms make the drone drift toward the bent corner. */
  private applyFrameBias(dt: number): void {
    if (!this.settings.partsDamage || !this.settings.frameDamage) return;
    const frame = this.damage.snapshot.frame;
    if (frame.yawBiasRad === 0 && frame.rollBiasRad === 0) return;
    this.quad.state.angularVelocity.y += frame.yawBiasRad * 6 * dt;
    this.quad.state.angularVelocity.x += frame.rollBiasRad * 6 * dt;
  }

  private handleCollisions(): void {
    const state = this.quad.state;
    const contact = detectCollision(
      state.position,
      state.velocity,
      state.orientation,
      this.bodyShape,
      {
        terrainHeight: (x, z) => this.terrain.sampleHeight(x, z),
        obstacles: this.terrain.collidable,
        waterHeight: null,
      },
    );
    this.lastContact = contact;
    if (!contact || contact.approachSpeed <= 0.05) return;

    const omega = Math.max(...this.quad.motorStates.map((m) => m.omega), 0);
    const energy = impactEnergy(
      this.build.auwKg,
      state.velocity,
      omega,
      4,
      this.build.motorInertiaKgM2,
      this.bodyShape.propRadius,
    );

    if (energy > 0.2) {
      if (this.settings.partsDamage) {
        this.damage.applyImpact(energy, this.settings, contact.surface, contact.normal);
      }
      state.lastImpactJoules = energy;
    }

    // Positional correction. Resolving velocity alone lets the drone sink
    // through the surface over several frames and end up inside the terrain.
    const correction = Math.min(contact.depth, 0.5);
    state.position.x += contact.normal.x * correction;
    state.position.y += contact.normal.y * correction;
    state.position.z += contact.normal.z * correction;

    // A hard enough hit is a crash no matter what the damage system says.
    const hardHit = energy > 18 || contact.approachSpeed > 14;
    const grounded = state.position.y - this.terrain.sampleHeight(state.position.x, state.position.z) < 0.25;

    if (hardHit && !grounded) {
      this.crashes++;
      state.crashed = true;
      this.phase = 'crashed';
      state.velocity = { x: 0, y: 0, z: 0 };
      state.angularVelocity = { x: 0, y: 0, z: 0 };
    } else {
      // Grass absorbs, concrete does not. Props skitter on a shallow hit.
      const restitution = contact.surface === 'grass' || contact.surface === 'foliage' ? 0.12 : 0.32;
      const friction = contact.surface === 'grass' ? 0.55 : 0.25;
      state.velocity = resolveContact(state.velocity, contact, restitution, friction);
      if (contact.approachSpeed < 2) {
        state.velocity.x *= 0.6;
        state.velocity.z *= 0.6;
      }
    }
  }

  /** Per-frame updates for systems that do not need the 500 Hz rate. */
  private updateNonPhysics(dt: number): void {
    const state = this.quad.state;
    const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    if (this.phase === 'flying') {
      this.distanceFlown += speed * dt;
      this.maxSpeed = Math.max(this.maxSpeed, speed);
    }

    if (this.settings.partsDamage) {
      this.damage.applyEnvironment(
        dt,
        this.settings.weather && this.settings.rain ? this.weather.weather.rainMmPerHour : 0,
        this.settings.weather ? this.weather.weather.humidity : 0.2,
        this.weather.weather.temperatureC,
        this.settings,
      );
    }

    // Wind settings follow the weather.
    if (this.settings.weather) {
      this.wind.settings.speed = this.weather.windSpeed;
      this.wind.settings.directionRad = (this.weather.windDirectionDeg * Math.PI) / 180;
    }
  }

  /** Signal evaluation, called at the UI rate rather than every substep. */
  private cachedSignal: SignalSnapshot | null = null;

  private updateSignal(dt: number): SignalSnapshot {
    const state = this.quad.state;
    this.signal.terrainClearance = this.settings.rfPenetration
      ? this.terrain.terrainClearance(this.pilotPosition, state.position)
      : 999;

    const antennaDamage = this.settings.partsDamage ? 1 + (1 - this.damage.electronicsHealth) * 0.6 : 1;

    if (!this.settings.signalStrength) {
      return NEUTRAL_SIGNAL;
    }

    this.cachedSignal = this.signal.evaluate(
      {
        pilotPosition: this.pilotPosition,
        dronePosition: state.position,
        control: this.build.control,
        video: this.build.video,
        obstructions: this.signal.obstructions,
        terrainClearance: this.signal.terrainClearance,
        rainMmPerHour: this.settings.rain ? this.weather.weather.rainMmPerHour : 0,
        damageFactor: antennaDamage,
      },
      dt,
    );
    return this.cachedSignal;
  }

  /** Everything the UI and renderer read. Safe to call at any rate. */
  snapshot(): WorldSnapshot {
    const state = this.quad.state;
    const basis = this.quad.basis();
    const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    const ground = this.terrain.sampleHeight(state.position.x, state.position.z);
    const signal = this.cachedSignal ?? this.updateSignal(1 / 60);
    const weatherSnapshot = this.weather.snapshot(state.position.y, airDensity);

    const slope = this.settings.weather
      ? this.terrain.slopeAlongWind(
          state.position.x,
          state.position.z,
          this.wind.settings.directionRad,
        )
      : 0;
    const windSample = this.settings.weather
      ? this.wind.sample(state.position, this.time, slope)
      : null;

    const attitudeDeg = {
      pitch: Math.asin(clamp(basis.forward.y, -1, 1)) * RAD2DEG,
      roll: Math.atan2(-basis.right.y, basis.up.y) * RAD2DEG,
      yaw: Math.atan2(basis.forward.x, basis.forward.z) * RAD2DEG,
    };

    const totalThrust = state.thrustN;
    return {
      phase: this.phase,
      time: this.time,
      flightTime: this.flightTime,
      armed: this.phase === 'armed' || this.phase === 'flying',

      position: { ...state.position },
      velocity: { ...state.velocity },
      speed,
      heightAgl: state.position.y - ground,
      altitudeMsl: state.position.y,
      attitudeDeg,

      thrustN: totalThrust,
      auwKg: this.build.auwKg,
      thrustToWeight: totalThrust / (this.build.auwKg * 9.80665),
      motorRpm: this.quad.motorStates.map((m) => (m.omega * 60) / (Math.PI * 2)),
      motorThrottle: [...state.motorThrottle],

      battery: { ...state.battery },
      signal,
      damage: this.damage.snapshot,
      weather: weatherSnapshot,
      wind: {
        speed: this.wind.settings.speed,
        directionDeg: this.weather.windDirectionDeg,
        gustSpeed: windSample ? Math.hypot(windSample.gust.x, windSample.gust.z) : 0,
        turbulence: windSample?.turbulence ?? 0,
        updraft: windSample?.updraft ?? 0,
        shear: windSample?.shear ?? 0,
      },

      contact: this.lastContact,
      crashes: this.crashes,
      distanceFlownM: this.distanceFlown,
      maxSpeed: this.maxSpeed,
      vibration: state.vibration,
      controlAuthority: this.lastAuthority,
    };
  }

  /** Advance signal and weather at the UI cadence. */
  tickSlow(dt: number): void {
    this.updateSignal(dt);
  }
}

/** Neutral signal state used when the signal systems are off. */
const NEUTRAL_SIGNAL: SignalSnapshot = {
  control: {
    rssiDbm: -60,
    lq: 100,
    state: 'strong',
    budget: {
      distanceM: 0,
      pathLossDb: 0,
      penetrationLossDb: 0,
      fresnelLossDb: 0,
      rxPowerDbm: -40,
      marginDb: 40,
      quality: 1,
    },
    fadingDb: 0,
  },
  video: {
    rssiDbm: -60,
    quality: 1,
    state: 'clean',
    budget: {
      distanceM: 0,
      pathLossDb: 0,
      penetrationLossDb: 0,
      fresnelLossDb: 0,
      rxPowerDbm: -40,
      marginDb: 40,
      quality: 1,
    },
    latencyMs: 20,
    snow: 0,
    droppedFrames: 0,
  },
  worst: 'none',
};

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

import { clamp } from '../math/vec3';

// --- Tuning bridge ---------------------------------------------------------
// Imported here (not at the top) to keep the world's dependency list readable:
// everything the simulation touches is visible in one place.
import { createDefaultTune, retune } from '../tuning/tuner';
