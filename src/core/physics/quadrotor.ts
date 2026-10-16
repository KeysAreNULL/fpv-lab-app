/**
 * Rigid-body quadrotor with anisotropic drag, ground effect, propwash and the
 * full electrical chain in the loop (motors draw current → battery sags →
 * motors make less thrust).
 *
 * Integrated semi-implicitly at a fixed substep. Everything is SI and in the
 * body frame unless a name says otherwise.
 *
 * Body frame (Betaflight / PX4 convention): +X right, +Y up, +Z forward.
 */

import { AIR_DENSITY_SEA_LEVEL, GRAVITY } from '../constants';
import type { ResolvedBuild } from '../build/resolve';
import { MOTOR_SPIN } from '../build/resolve';
import {
  eulerToQuat,
  integrateQuat,
  invertSpd3,
  mat3MulVec,
  quatToBasis,
  type Mat3,
  type Quat,
} from '../math/quat';
import { add, applyQuat, clamp, cross, dot, lengthSq, scale, sub, type Vec3 } from '../math/vec3';
import { Battery, openCircuitVoltage } from './battery';
import { FlightController, type AxisDemand } from './controller';
import { buildMotorModel, createMotorState, stepMotor, torqueConstantFor, type MotorModel, type MotorState } from './motor';
import type { TuningState } from '../tuning/tuner';

/** Fixed physics substep. Never tie this to the frame rate. */
export const PHYSICS_DT = 1 / 500;

/** Aerodynamic rotational damping, N·m per rad/s. */
const ROT_DAMP = 0.02;

export interface ControlInput {
  /** −1..1, +1 pitches the nose down. */
  pitch: number;
  /** −1..1, +1 rolls right. */
  roll: number;
  /** −1..1, +1 yaws right (clockwise from above). */
  yaw: number;
  /** 0..1 collective. */
  throttle: number;
}

export const ZERO_INPUT: ControlInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };

export interface BatteryStateView {
  soc: number;
  voltage: number;
  cellVoltage: number;
  currentAmps: number;
  powerWatts: number;
  temperatureC: number;
  remainingSeconds: number;
  brownout: boolean;
  health: number;
}

export interface QuadState {
  /** World position, metres. */
  position: Vec3;
  /** World velocity, m/s. */
  velocity: Vec3;
  /** Body orientation. */
  orientation: Quat;
  /** Body angular velocity, rad/s. */
  angularVelocity: Vec3;
  /** Per-motor throttle after the mixer, 0..1. */
  motorThrottle: [number, number, number, number];
  /** What the flight controller asked the mixer for, −1..1. */
  controlDemand: AxisDemand;
  readonly motor: readonly MotorState[];
  battery: BatteryStateView;
  thrustN: number;
  /** Body-frame aerodynamic drag force, N. */
  dragN: Vec3;
  heightAgl: number;
  brownout: boolean;
  crashed: boolean;
  lastImpactJoules: number;
  /** Prop thrust health, 0..1, from damage. */
  propHealth: number;
  /** Motor thrust health, 0..1, from damage. */
  motorHealth: number;
  /** Accumulated propeller imbalance, drives vibration in the video feed. */
  vibration: number;
  /** Extra gyro noise from a damaged flight controller, rad. */
  gyroNoiseRad: number;
}

export interface WorldEnvironment {
  /** Air density, kg/m³. */
  rho: number;
  /** Wind velocity at the drone, m/s, world frame. */
  wind: Vec3;
  /** Ground height under the drone, m. */
  groundHeight: number;
}

export class Quadrotor {
  readonly build: ResolvedBuild;
  readonly battery: Battery;
  readonly controller = new FlightController();
  private readonly motorModel: MotorModel;
  private readonly motors: MotorState[];
  private readonly inverseInertia: Mat3;

  readonly state: QuadState;

  constructor(build: ResolvedBuild, ambientC = 20) {
    this.build = build;
    this.motorModel = buildMotorModel(
      { ...(build.motor ?? FALLBACK_MOTOR) },
      build.propModel,
      build.electrical.escMaxAmps,
    );
    this.motors = [0, 1, 2, 3].map(() => createMotorState());
    this.battery = build.battery
      ? new Battery(build.battery, ambientC)
      : new Battery(FALLBACK_BATTERY, ambientC);

    const start = { x: 0, y: 0.3, z: 0 };
    this.state = {
      position: { ...start },
      velocity: { x: 0, y: 0, z: 0 },
      orientation: eulerToQuat(0, 0, 0),
      angularVelocity: { x: 0, y: 0, z: 0 },
      motorThrottle: [0, 0, 0, 0],
      controlDemand: { roll: 0, pitch: 0, yaw: 0 },
      motor: this.motors,
      battery: {
        soc: this.battery.state.soc,
        voltage: openCircuitVoltage(this.battery.state.soc) * Math.max(build.electrical.cells, 1),
        cellVoltage: openCircuitVoltage(this.battery.state.soc),
        currentAmps: 0,
        powerWatts: 0,
        temperatureC: ambientC,
        remainingSeconds: Number.POSITIVE_INFINITY,
        brownout: false,
        health: 1,
      },
      thrustN: 0,
      dragN: { x: 0, y: 0, z: 0 },
      heightAgl: start.y,
      brownout: false,
      crashed: false,
      lastImpactJoules: 0,
      propHealth: 1,
      motorHealth: 1,
      vibration: 0,
      gyroNoiseRad: 0,
    };

    this.inverseInertia = invertSpd3(build.inertia);
  }

  /** Reset to the spawn state with a fresh battery. */
  reset(position?: Vec3): void {
    this.battery.recharge();
    this.controller.reset();
    for (const m of this.motors) {
      m.omega = 0;
      m.omegaTarget = 0;
      m.thrustN = 0;
      m.currentAmps = 0;
      m.powerWatts = 0;
      m.throttle = 0;
      m.currentLimited = false;
    }
    this.state.position = { ...(position ?? this.state.position) };
    this.state.velocity = { x: 0, y: 0, z: 0 };
    this.state.orientation = eulerToQuat(0, 0, 0);
    this.state.angularVelocity = { x: 0, y: 0, z: 0 };
    this.state.thrustN = 0;
    this.state.crashed = false;
    this.state.lastImpactJoules = 0;
    this.state.vibration = 0;
    this.state.gyroNoiseRad = 0;
  }

  /**
   * Mixer.
   *
   * Roll and pitch redistribute thrust without changing the total. Yaw has no
   * differential-thrust path on a symmetric X quad — all yaw torque comes from
   * the prop reaction torque — so raising the counter-clockwise motors (1, 2)
   * pushes the airframe clockwise.
   *
   * Motor order: 0 rear-right, 1 front-right, 2 rear-left, 3 front-left.
   */
  mix(throttle: number, demand: AxisDemand): [number, number, number, number] {
    const t = clamp(throttle, 0, 1);
    const rollW = [1, 1, -1, -1];
    const pitchW = [-1, 1, -1, 1];
    const yawW = [-1, 1, 1, -1];

    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      out[i] = clamp(
        t - demand.roll * rollW[i] - demand.pitch * pitchW[i] + demand.yaw * yawW[i],
        0,
        1,
      );
    }
    return out;
  }

  /**
   * One fixed physics substep.
   *
   * @param authority global control-authority multiplier from damage and
   *   failsafe, 0..1. The flight controller scales its output by this.
   */
  step(
    dt: number,
    input: ControlInput,
    env: WorldEnvironment,
    tune: TuningState,
    authority = 1,
  ): QuadState {
    const s = this.state;
    const build = this.build;

    // --- Flight controller -------------------------------------------------
    this.controller.tickNoise(dt);
    const demand = this.controller.step(
      dt,
      { roll: clamp(input.roll, -1, 1), pitch: clamp(input.pitch, -1, 1), yaw: clamp(input.yaw, -1, 1) },
      s.angularVelocity,
      tune,
      authority,
      s.gyroNoiseRad,
    );
    s.controlDemand = demand;

    // --- Height above ground, and the air under each prop -------------------
    s.heightAgl = Math.max(0, s.position.y - env.groundHeight);
    const propHeightAgl = Math.max(0.02, s.heightAgl + build.propModel.diameterM * 0.1);

    // --- Motors + battery, coupled -------------------------------------------
    const throttles = this.mix(input.throttle, demand);
    s.motorThrottle = throttles;

    // Airspeed at each disc along the thrust axis.
    const thrustAxisWorld = applyQuat({ x: 0, y: 1, z: 0 }, s.orientation);
    const relativeWind = sub(s.velocity, env.wind);

    let totalThrust = 0;
    let totalCurrent = 0;
    let yawTorque = 0;
    let torqueSum: Vec3 = { x: 0, y: 0, z: 0 };
    const kProp = torqueConstantFor(build.propModel, env.rho);

    for (let i = 0; i < 4; i++) {
      const motor = this.motors[i];
      const mount = build.motors[i];
      // Negative airSpeed along the thrust axis is a headwind.
      const airSpeed = -dot(relativeWind, thrustAxisWorld);

      stepMotor(
        this.motorModel,
        motor,
        dt,
        throttles[i],
        this.battery.state.voltage,
        env.rho,
        propHeightAgl,
        airSpeed,
        s.propHealth * s.motorHealth,
      );

      totalThrust += motor.thrustN;
      totalCurrent += motor.currentAmps;

      // Thrust torque about the body CG: τ = r × F.
      torqueSum = add(torqueSum, cross(mount.position, { x: 0, y: motor.thrustN, z: 0 }));

      // Prop reaction torque. A prop spinning about +spin·Y drags its stator
      // the other way, so the reaction on the frame is −spin·τ_prop about Y.
      const propTorque = kProp * motor.omega * motor.omega;
      yawTorque -= MOTOR_SPIN[i] * propTorque;
    }

    s.thrustN = totalThrust;

    // --- Battery -------------------------------------------------------------
    // Motors at full throttle on a 6S 1300 pull ~100 A; a 6.5 mΩ pack drops
    // roughly 0.65 V under that load and every motor loses thrust with it.
    const batt = this.battery.step(totalCurrent, dt);
    s.brownout = batt.brownout;
    s.battery = {
      soc: batt.soc,
      voltage: batt.voltage,
      cellVoltage: batt.cellVoltage,
      currentAmps: totalCurrent,
      powerWatts: batt.voltage * totalCurrent,
      temperatureC: batt.temperatureC,
      remainingSeconds: this.battery.remainingSeconds(totalCurrent),
      brownout: batt.brownout,
      health: batt.health,
    };

    // --- Aerodynamic drag -----------------------------------------------------
    s.dragN = dragForce(relativeWind, s.orientation, build, env.rho);

    // --- Translational dynamics ----------------------------------------------
    const thrustWorld = scale(thrustAxisWorld, totalThrust);
    const dragWorld = applyQuat(s.dragN, s.orientation);
    const force = sub(add(thrustWorld, dragWorld), { x: 0, y: build.auwKg * GRAVITY, z: 0 });
    const accel = scale(force, 1 / Math.max(build.auwKg, 0.01));

    s.velocity = add(s.velocity, scale(accel, dt));
    s.position = add(s.position, scale(s.velocity, dt));

    // --- Rotational dynamics --------------------------------------------------
    const omega = s.angularVelocity;
    const torqueBody = add(torqueSum, {
      x: -omega.x * ROT_DAMP,
      y: yawTorque - omega.y * ROT_DAMP,
      z: -omega.z * ROT_DAMP,
    });
    // `inverseInertia` is already inverted — do not invert it twice.
    const angularAccel = mat3MulVec(this.inverseInertia, torqueBody);
    s.angularVelocity = add(omega, scale(angularAccel, dt));
    if (lengthSq(s.angularVelocity) < 1e-8) s.angularVelocity = { x: 0, y: 0, z: 0 };

    s.orientation = integrateQuat(s.orientation, s.angularVelocity, dt);

    // --- Vibration from a damaged / unbalanced prop set ------------------------
    const imbalance = (1 - s.propHealth) * clamp(totalCurrent / 60, 0, 1.5);
    s.vibration += (imbalance - s.vibration) * Math.min(1, dt * 6);

    return s;
  }

  /** Basis vectors in world space — the renderer and collision both need these. */
  basis(): ReturnType<typeof quatToBasis> {
    return quatToBasis(this.state.orientation);
  }

  get motorStates(): readonly MotorState[] {
    return this.motors;
  }
}

/**
 * Anisotropic body drag in the body frame. A quad presents roughly 5× the
 * frontal area edge-on and its flat planform bites hard from above, which is
 * why forward flight is slow and vertical descent is slower still.
 */
function dragForce(
  relativeVelocity: Vec3,
  orientation: Quat,
  build: ResolvedBuild,
  rho: number,
): Vec3 {
  const basis = quatToBasis(orientation);
  const vx = dot(relativeVelocity, basis.right);
  const vy = dot(relativeVelocity, basis.up);
  const vz = dot(relativeVelocity, basis.forward);
  const aero = build.aero;
  const k = 0.5 * rho;
  return {
    x: -k * aero.cdSide * aero.sideAreaM2 * Math.abs(vx) * vx,
    y: -k * aero.cdTop * aero.topAreaM2 * Math.abs(vy) * vy,
    z: -k * aero.cdFrontal * aero.frontalAreaM2 * Math.abs(vz) * vz,
  };
}

export { AIR_DENSITY_SEA_LEVEL };

const FALLBACK_MOTOR = {
  id: 'fallback-motor',
  brand: '',
  name: '',
  category: 'motor' as const,
  massGrams: 32,
  priceUsd: 0,
  specSource: 'datasheet' as const,
  statorSize: '2207',
  kvRpmPerVolt: 1750,
  phaseResistanceMilliOhm: 140,
  maxCurrentAmps: 40,
  maxThrustGrams: 1800,
  maxThrustVolts: 25.2,
  rotorInertiaKgM2: 1.2e-5,
  bellDiameterMm: 28,
  bellHeightMm: 19.5,
  shaftDiameterMm: 5 as const,
  mount: '22x22' as const,
  loadedKvFactor: 0.9,
};

const FALLBACK_BATTERY = {
  id: 'fallback-battery',
  brand: '',
  name: '',
  category: 'battery' as const,
  massGrams: 200,
  priceUsd: 0,
  specSource: 'datasheet' as const,
  cells: 6 as const,
  capacityMah: 1300,
  cRating: 100,
  cellType: '18650' as const,
  packResistanceMilliOhm: 7,
  nominalVoltage: 22.2,
  maxVoltage: 25.2,
  minVoltagePerCell: 3,
  connector: 'XT60' as const,
  burstDischargeAmps: 120,
};
