/**
 * Brushless outrunners on an ESC.
 *
 * Per substep the model solves, in order:
 *   1. Motor speed from the electrical balance  V = Ke·ω + I·R
 *      combined with the prop load               τ = Ke·I = k_p·ω²
 *      giving the quadratic   k_p·R·ω² + Ke²·ω − Ke·V = 0.
 *   2. Current from the balance, clamped to the ESC's rating. Real BLHeli_32
 *      4-in-1s saturate here, and it is what caps a 5" quad's thrust on 6S at
 *      around 2 kgf instead of the theoretical 8 kgf.
 *   3. Thrust from Ct·ρ·n²·D⁴, with ground effect and advance-ratio corrections.
 *   4. First-order lag between commanded duty and delivered torque, because an
 *      ESC takes 20–60 ms to spool a motor up. Removing this is what makes a
 *      quad feel like a toy rather than a quad.
 *
 * Battery sag enters through `packVoltage`, which is the sagging terminal
 * voltage, never the nominal one. That single coupling is the most important
 * realism loop in the app.
 */

import { rpmToRadPerSec, TWO_PI } from '../constants';
import { clamp } from '../math/vec3';
import type { MotorPart } from '../parts/spec';
import { groundEffectFactor, propPower, propThrustMoving, type PropModel } from './prop';

/** ESC PWM → torque response time constant, seconds. */
export const MOTOR_TAU = 0.025;

/** Duty cycle → commanded motor torque as a fraction of the electrical maximum. */
export const COMMAND_CEILING = 0.98;

export interface MotorState {
  /** Actual angular velocity, rad/s. */
  omega: number;
  /** Commanded angular velocity target, rad/s (lags behind by MOTOR_TAU). */
  omegaTarget: number;
  /** Thrust, N. Positive is up. */
  thrustN: number;
  /** Phase current, A. */
  currentAmps: number;
  /** Shaft power, W. */
  powerWatts: number;
  /** Commanded throttle 0..1 after the mixer. */
  throttle: number;
  /** True when the ESC hit its current ceiling this substep. */
  currentLimited: boolean;
}

export interface MotorModel {
  readonly ke: number;
  readonly resistanceOhm: number;
  readonly currentLimitAmps: number;
  readonly inertiaKgM2: number;
  readonly prop: PropModel;
  readonly maxOmega: number;
}

export const buildMotorModel = (motor: MotorPart, prop: PropModel, escMaxAmps: number): MotorModel => ({
  // Back-EMF constant: V per rad/s. Ke = 60 / (2π·Kv).
  ke: 60 / (TWO_PI * motor.kvRpmPerVolt),
  resistanceOhm: motor.phaseResistanceMilliOhm / 1000,
  // The weaker of the motor's own rating and the ESC's saturates first. Using
  // the max here lets a 25 A motor pull 54 A off a 60 A ESC, which no real
  // build does and which would let thrust run away.
  currentLimitAmps: Math.min(motor.maxCurrentAmps, escMaxAmps),
  inertiaKgM2: motor.rotorInertiaKgM2,
  prop,
  maxOmega: rpmToRadPerSec(motor.kvRpmPerVolt * motor.maxThrustVolts),
});

/**
 * Steady-state speed for a given supply voltage and prop, from
 *   k_p·R·ω² + Ke²·ω − Ke·V = 0
 * Solved on the positive root. `kP` is Cp·ρ·D⁵/(2π)³.
 */
export function steadyStateOmega(
  ke: number,
  resistance: number,
  kP: number,
  voltage: number,
): number {
  if (voltage <= 0) return 0;
  const a = kP * resistance;
  const b = ke * ke;
  const c = -ke * voltage;
  if (Math.abs(a) < 1e-14) return c < 0 ? Math.sqrt(Math.max(-c / b, 0)) : 0;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return 0;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

/** Prop torque constant k_p = Cp·ρ·D⁵/(2π)³ for the current air density. */
export function torqueConstantFor(prop: PropModel, rho: number): number {
  return (prop.cp * rho * Math.pow(prop.diameterM, 5)) / Math.pow(TWO_PI, 3);
}

export function createMotorState(): MotorState {
  return {
    omega: 0,
    omegaTarget: 0,
    thrustN: 0,
    currentAmps: 0,
    powerWatts: 0,
    throttle: 0,
    currentLimited: false,
  };
}

/**
 * Step one motor.
 *
 * @param dt         substep, seconds
 * @param throttle   commanded 0..1 from the mixer
 * @param packVoltage sagging terminal voltage from the battery, V
 * @param rho        air density, kg/m³
 * @param heightAgl  prop height above ground, m — drives ground effect
 * @param axialSpeed airspeed through the disc, m/s (negative = headwind)
 * @param healthScale 0..1 thrust multiplier from prop damage
 */
export function stepMotor(
  model: MotorModel,
  state: MotorState,
  dt: number,
  throttle: number,
  packVoltage: number,
  rho: number,
  heightAgl: number,
  axialSpeed: number,
  healthScale = 1,
): MotorState {
  const kP = torqueConstantFor(model.prop, rho);

  // Effective supply voltage: duty × pack voltage. Above ~30% duty the motor is
  // out of its linear region and behaves like a stiff current source, which the
  // quadratic solve captures naturally.
  const commanded = clamp(throttle, 0, 1) * COMMAND_CEILING;
  const voltage = commanded * Math.max(packVoltage, 0);

  // Target speed for this command, then the ESC lag.
  const targetOmega = Math.min(steadyStateOmega(model.ke, model.resistanceOhm, kP, voltage), model.maxOmega);
  const alpha = 1 - Math.exp(-dt / MOTOR_TAU);
  state.omega += (targetOmega - state.omega) * alpha;
  state.omegaTarget = targetOmega;
  if (state.omega < 1e-3) state.omega = 0;

  // Current from the electrical balance, then the ESC ceiling.
  const omega = state.omega;
  const backEmf = model.ke * omega;
  let current = 0;
  let limited = false;
  if (omega > 0 && commanded > 0) {
    // Effective bus voltage at the duty we are actually running.
    const actualVoltage = voltage;
    current = (actualVoltage - backEmf) / model.resistanceOhm;
    if (current > model.currentLimitAmps) {
      current = model.currentLimitAmps;
      limited = true;
    }
    current = Math.max(0, current);
  }

  // Thrust: prop curve with ground effect and advance ratio.
  const axial = -axialSpeed; // headwind (negative velocity) gives more thrust
  const ge = groundEffectFactor(heightAgl, model.prop.diameterM);
  const thrust = propThrustMoving(model.prop, omega, rho, axial) * ge * healthScale;

  state.thrustN = thrust;
  state.currentAmps = current;
  state.powerWatts = propPower(model.prop, omega, rho) * 1.08;
  state.throttle = throttle;
  state.currentLimited = limited;
  return state;
}

/** Test/diagnostic helper: rpm ↔ rad/s without pulling in the constants module twice. */
export const motorRpm = (omega: number): number => (omega * 60) / TWO_PI;
