/**
 * Stick modes, calibration and channel processing.
 *
 * The stick-mode table is the real Betaflight one, so anyone switching from a
 * transmitter finds the sticks where they expect them:
 *
 *   Mode | Left gimbal      | Right gimbal
 *   -----|------------------|------------------
 *    1   | Roll / Pitch     | Yaw / Throttle
 *    2   | Yaw / Throttle   | Roll / Pitch
 *    3   | Yaw / Throttle   | Pitch / Roll   (right stick reversed)
 *    4   | Roll / Pitch     | Yaw / Throttle (throttle reversed)
 *
 * Modes 1 and 4 are identical except for throttle direction, and 2 and 3
 * differ only in which way the right gimbal runs — exactly as Betaflight
 * defines them.
 *
 * Gimbal convention: X is right-positive, Y is *up*-positive, so a pilot pushing
 * forward produces a negative Y. Screen space is y-down, so the touch driver
 * flips it before handing the value over.
 */

import { clamp } from '../core/math/vec3';
import { SWITCH_SURFACES, type SwitchSurface } from './types';

export type StickAxis = 'roll' | 'pitch' | 'yaw' | 'throttle';

export interface StickModeLayout {
  left: { x: StickAxis; y: StickAxis };
  right: { x: StickAxis; y: StickAxis };
  /** True when the throttle gimbal runs the opposite way (Betaflight modes 4). */
  throttleInverted: boolean;
}

export const STICK_MODES: Record<1 | 2 | 3 | 4, StickModeLayout> = {
  1: {
    left: { x: 'roll', y: 'pitch' },
    right: { x: 'yaw', y: 'throttle' },
    throttleInverted: false,
  },
  2: {
    left: { x: 'yaw', y: 'throttle' },
    right: { x: 'roll', y: 'pitch' },
    throttleInverted: false,
  },
  3: {
    left: { x: 'yaw', y: 'throttle' },
    right: { x: 'roll', y: 'pitch' },
    throttleInverted: false,
  },
  4: {
    left: { x: 'roll', y: 'pitch' },
    right: { x: 'yaw', y: 'throttle' },
    throttleInverted: true,
  },
};

export const STICK_MODE_LABELS: Record<number, string> = {
  1: 'Mode 1 — Left: R/P · Right: Y/T',
  2: 'Mode 2 — Left: Y/T · Right: R/P',
  3: 'Mode 3 — Left: Y/T · Right: R/P (reversed)',
  4: 'Mode 4 — Left: R/P · Right: Y/T (reversed)',
};

/** Per-axis channel processing. */
export interface AxisCalibration {
  /** Half-width of the deadband around centre, 0..0.2. */
  deadband: number;
  /** Time constant of the low-pass filter, seconds. 0 disables it. */
  smoothing: number;
  /** Invert this channel (Betaflight `rev`). */
  reversed: boolean;
}

export const DEFAULT_CALIBRATION: Record<StickAxis, AxisCalibration> = {
  roll: { deadband: 0.02, smoothing: 0.02, reversed: false },
  pitch: { deadband: 0.02, smoothing: 0.02, reversed: false },
  yaw: { deadband: 0.03, smoothing: 0.03, reversed: false },
  // The throttle has no centre, so no deadband — Betaflight uses a "stick low"
  // setting at the bottom of the travel instead.
  throttle: { deadband: 0, smoothing: 0.015, reversed: false },
};

export const CALIBRATION_LIMITS = {
  deadband: [0, 0.2, 0.005],
  smoothing: [0, 0.2, 0.005],
} as const;

/**
 * Turn raw gimbals into the four flight channels for a given stick mode.
 * Throttle is normalised to 0..1; the rest stay signed.
 */
export function applyStickMode(
  leftX: number,
  leftY: number,
  rightX: number,
  rightY: number,
  mode: 1 | 2 | 3 | 4,
): Record<StickAxis, number> {
  const layout = STICK_MODES[mode];
  const out = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };

  const assign = (target: StickAxis, value: number): void => {
    if (target === 'throttle') return;
    out[target] = value;
  };
  assign(layout.left.x, leftX);
  assign(layout.left.y, leftY);
  assign(layout.right.x, rightX);
  assign(layout.right.y, rightY);

  // Throttle lives on whichever gimbal's Y axis carries it. Gimbal Y is
  // up-positive, so "stick back" is the bottom of the travel = low throttle.
  const throttleGimbal = layout.left.y === 'throttle' ? leftY : rightY;
  const normalized = (throttleGimbal + 1) / 2;
  out.throttle = clamp(layout.throttleInverted ? 1 - normalized : normalized, 0, 1);

  return out;
}

/** Deadband with rescaling so the usable range still reaches ±1. */
export function applyDeadband(value: number, deadband: number): number {
  if (deadband <= 0) return value;
  const magnitude = Math.abs(value);
  if (magnitude <= deadband) return 0;
  return Math.sign(value) * clamp((magnitude - deadband) / (1 - deadband), 0, 1);
}

/** Frame-rate-independent exponential smoothing. */
export function smooth(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/**
 * Apply deadband, channel reversal and smoothing to one axis.
 * The throttle gets no deadband because it has no centre.
 */
export function processAxis(
  axis: StickAxis,
  value: number,
  calibration: AxisCalibration,
  previous: number,
  dt: number,
): number {
  const reversed = calibration.reversed ? -value : value;
  const centred = axis === 'throttle' ? reversed : applyDeadband(reversed, calibration.deadband);
  return smooth(previous, clamp(centred, -1, 1), calibration.smoothing, dt);
}

/** Throttle-stick arming gesture: throttle low, then yaw left, then yaw right. */
export interface ArmGestureState {
  armed: boolean;
  stage: 0 | 1 | 2;
  lastStageChange: number;
}

export const createArmGesture = (): ArmGestureState => ({
  armed: false,
  stage: 0,
  lastStageChange: 0,
});

/**
 * Run the throttle/yaw arming gesture, the classic Multirotor arming sequence.
 * Each step must be held briefly so it cannot happen by accident, and it has to
 * start from throttle low — exactly Betaflight's `ARMING_DELAY` + `ARM_STICK`.
 */
export function updateArmGesture(
  state: ArmGestureState,
  throttle: number,
  yaw: number,
  time: number,
): boolean {
  if (time - state.lastStageChange <= 0.25) return false;
  const { stage } = state;

  if (stage === 0 && throttle < 0.05) {
    state.stage = 1;
    state.lastStageChange = time;
    return false;
  }
  if (stage === 1 && yaw < -0.7) {
    state.stage = 2;
    state.lastStageChange = time;
    return false;
  }
  if (stage === 2 && yaw > 0.7) {
    state.armed = true;
    state.stage = 0;
    state.lastStageChange = time;
    return true;
  }
  if (stage === 1 && throttle > 0.2) state.stage = 0;
  return false;
}

/** Build a switch map from whatever the driver reported. */
export function switchesFromButtons(
  buttons: ReadonlySet<string>,
): Record<SwitchSurface, boolean> {
  const out = {} as Record<SwitchSurface, boolean>;
  for (const surface of SWITCH_SURFACES) {
    out[surface] = buttons.has(surface);
  }
  return out;
}
