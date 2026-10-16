/**
 * Propeller aerodynamics.
 *
 * Thrust and torque are derived from the blade geometry rather than looked up,
 * so a prop is always self-consistent:
 *
 *   T = Ct · ρ · n² · D⁴          (thrust,      n = rev/s, D = m)
 *   P = Cp · ρ · n³ · D⁵          (shaft power)
 *   τ = P / ω                     (shaft torque, ω = 2πn)
 *
 * Ct is the conventional thrust coefficient that pairs with `ρ n² D⁴`. It is
 * derived from the ideal-disc coefficient via the π/8 area factor:
 *
 *   Ct_disc ≈ 0.198 · (p/D)       static thrust coefficient on the disc area
 *   Ct      = Ct_disc · π/8
 *
 * Cp follows from the figure of merit at a standing hover: the induced power is
 * T·v_i with v_i = nD, and P_shaft = P_induced / FoM, so Cp = Ct / FoM.
 *
 * That same relation gives shaft torque directly, and it is the number the motor
 * model needs:
 *
 *   τ = P/ω = T·D / (2π · FoM)
 *
 * Note the FoM is in the denominator. A less efficient prop needs more torque to
 * make the same thrust, which is exactly why it costs more current.
 *
 * Calibration check (HQ R38 5.1"x3.6"x3 on 6S with a 1750KV motor): Ct = 0.0551,
 * which gives 5.4 N per motor at 32,000 rpm drawing ~29 A — matching bench data.
 */

import { inchToMeter } from '../constants';
import type { PropPart } from '../parts/spec';

export interface PropModel {
  /** Thrust coefficient, pairs with T = Ct ρ n² D⁴. */
  readonly ct: number;
  /** Power coefficient, pairs with P = Cp ρ n³ D⁵. */
  readonly cp: number;
  /** Diameter in metres. */
  readonly diameterM: number;
  /** Disc area in m². */
  readonly discAreaM2: number;
  /** Mass in kg. */
  readonly massKg: number;
  readonly bladeCount: number;
  /** I/(m·r²) — inertial coupling factor for a blade element. */
  readonly inertiaRatio: number;
}

/** Ideal-disc static thrust coefficient as a function of blade pitch ratio. */
const discThrustCoefficient = (pitchRatio: number): number => 0.198 * pitchRatio;

export function buildPropModel(part: PropPart): PropModel {
  const diameterM = inchToMeter(part.diameterInches);
  const pitchRatio = part.pitchInches / part.diameterInches;
  const ctDisc = discThrustCoefficient(pitchRatio);
  const ct = ctDisc * (Math.PI / 8);
  const cp = ct / Math.max(part.figureOfMerit, 0.05);
  return {
    ct,
    cp,
    diameterM,
    discAreaM2: (Math.PI * diameterM * diameterM) / 4,
    massKg: part.massGrams / 1000,
    bladeCount: part.bladeCount,
    inertiaRatio: 0.75,
  };
}

/** Thrust in newtons at `omega` rad/s. */
export const propThrust = (m: PropModel, omega: number, rho: number): number => {
  if (omega <= 0 || rho <= 0) return 0;
  const n = omega / (2 * Math.PI);
  return m.ct * rho * n * n * Math.pow(m.diameterM, 4);
};

/** Shaft power in watts at `omega` rad/s. */
export const propPower = (m: PropModel, omega: number, rho: number): number => {
  if (omega <= 0 || rho <= 0) return 0;
  const n = omega / (2 * Math.PI);
  return m.cp * rho * n * n * n * Math.pow(m.diameterM, 5);
};

/** Shaft torque in N·m at `omega` rad/s. Equals power / omega. */
export const propTorque = (m: PropModel, omega: number, rho: number): number => {
  if (omega <= 0) return 0;
  return propPower(m, omega, rho) / omega;
};

/**
 * Torque coefficient in the P = k·ω³ form, precomputed for the integrator so
 * the hot loop does not recompute Cp and the powers of D every substep.
 */
export const torqueConstant = (m: PropModel, rho: number): number => {
  const k = m.cp * rho * Math.pow(m.diameterM, 5);
  return k / Math.pow(2 * Math.PI, 3);
};

/**
 * Ground effect: below roughly one prop diameter of clearance, induced velocity
 * at the disc is reduced by the ground plane and thrust rises. Uses the classic
 * flat-ground correction, capped because the asymptotic form diverges.
 *
 *   T/T∞ = 1 / (1 − (R / 4h)²)
 */
export const groundEffectFactor = (heightMeters: number, diameterM: number): number => {
  if (diameterM <= 0) return 1;
  const h = Math.max(heightMeters, 0.02);
  const ratio = diameterM / (4 * h);
  const denom = 1 - ratio * ratio;
  if (denom <= 0.05) return 4;
  return 1 / denom;
};

/**
 * Advance ratio — airspeed through the disc normalised by tip speed. Used by
 * the wind model: a prop fighting a headwind produces more thrust for the same
 * shaft power, which is why a punchout into wind loses ground speed slowly.
 */
export const advanceRatio = (m: PropModel, omega: number, axialSpeed: number): number => {
  const tipSpeed = Math.abs(omega) * (m.diameterM / (2 * Math.PI));
  if (tipSpeed <= 1e-3) return 0;
  return Math.abs(axialSpeed) / tipSpeed;
};

/**
 * Thrust with the advance-ratio correction folded in. A prop moving forward
 * through still air has to accelerate less air per revolution, so it makes more
 * thrust at a given rpm than a static bench test would suggest.
 */
export const propThrustMoving = (
  m: PropModel,
  omega: number,
  rho: number,
  axialSpeed: number,
): number => {
  const j = Math.abs(advanceRatio(m, omega, axialSpeed));
  const jClamped = Math.min(j, 1.4);
  // Ct falls roughly linearly with J over the useful range.
  const factor = Math.max(0.15, 1 - 0.55 * jClamped);
  return propThrust(m, omega, rho) * factor;
};
