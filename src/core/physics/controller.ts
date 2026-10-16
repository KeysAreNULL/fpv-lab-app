/**
 * Flight controller — the Betaflight control cascade, simplified but faithful.
 *
 * Betaflight is a single-rate PID loop running at 8 kHz. A stick deflection does
 * not go straight to the mixer; it goes through four stages:
 *
 *   1. **Rates.** The stick position is shaped by the RC rate curve into a
 *      *rate setpoint* in degrees per second. This is why a high rate profile
 *      makes the quad feel like it is being thrown rather than steered.
 *   2. **P term.** P · (setpoint − gyro) is the main attitude demand. Raising P
 *      makes the quad fight harder to reach the commanded rate, which is why
 *      raising P also makes it twitchier: you are commanding larger mixer
 *      differentials, not just correcting faster.
 *   3. **Feedforward.** F · (setpoint − previous setpoint). This is the term
 *      that produces the crisp, immediate response people describe as "snappy".
 *      It reacts to the *command*, not the error, so it is essentially a
 *      prediction of what the gyro is about to do.
 *   4. **D term.** D on the gyro *measurement*, not the error. That distinction
 *      matters: D on the error would amplify setpoint changes and buzz; D on the
 *      measurement damps real motion and is what stops a quad oscillating.
 *
 * The I term exists to kill steady-state error from a leaning CG or an
 * off-centre mass. It is deliberately small — too much and the quad hunts.
 *
 * The output is a normalised demand in [-1, 1] per axis, which is exactly what
 * the mixer consumes.
 */

import { RAD2DEG, DEG2RAD } from '../constants';
import { clamp } from '../math/vec3';
import { applyRates, type RateProfile, type TuningState } from '../tuning/tuner';

export interface AxisDemand {
  roll: number;
  pitch: number;
  yaw: number;
}

export interface GyroSample {
  /** Body angular velocity, rad/s, raw (x = pitch, z = roll, y = yaw). */
  x: number;
  y: number;
  z: number;
}

export interface ControllerDebug {
  /** Commanded rate setpoints, deg/s. */
  setpointDegS: AxisDemand;
  /** Actual body rates in pilot axes, deg/s. */
  actualDegS: AxisDemand;
  /** Each PID contribution, normalised. */
  pTerm: AxisDemand;
  iTerm: AxisDemand;
  dTerm: AxisDemand;
  fTerm: AxisDemand;
  /** True when the I term has wound up and is being held off. */
  antiWindup: boolean;
}

const ZERO: AxisDemand = { roll: 0, pitch: 0, yaw: 0 };

/**
 * Normalisation constants mapping Betaflight-scale gains (P ~50, D ~38, F ~115)
 * onto the mixer's [-1, 1] output.
 *
 * The mixer saturates demand at 1.0, which corresponds to Betaflight's ~500
 * unit clip. A P term therefore reaches half authority at an error of about
 * 0.5 rad/s, and F saturates on the substep where a stick is slammed over —
 * which is precisely the "snap" pilots describe. Without these constants the
 * raw gains are off by four orders of magnitude against the mixer.
 */
const P_NORMALISE = 0.02;
const I_NORMALISE = 0.0008;
const F_NORMALISE = 0.02;

/** Clamp each PID contribution so no single term can dominate the sum. */
const TERM_CLAMP = 0.6;

export class FlightController {
  private iRoll = 0;
  private iPitch = 0;
  private iYaw = 0;
  private prevSetpoint: AxisDemand = { ...ZERO };
  private prevGyro: AxisDemand = { ...ZERO };
  private noisePhase = 0;

  debug: ControllerDebug = {
    setpointDegS: { ...ZERO },
    actualDegS: { ...ZERO },
    pTerm: { ...ZERO },
    iTerm: { ...ZERO },
    dTerm: { ...ZERO },
    fTerm: { ...ZERO },
    antiWindup: false,
  };

  reset(): void {
    this.iRoll = this.iPitch = this.iYaw = 0;
    this.prevSetpoint = { ...ZERO };
    this.prevGyro = { ...ZERO };
  }

  /**
   * Convert raw body angular velocity into pilot axes.
   *
   * With +X right, +Y up, +Z forward:
   *   ω.x > 0 tips the nose down       → pitch rate, positive forward
   *   ω.z > 0 rolls the left side up   → roll rate is −ω.z
   *   ω.y > 0 yaws counter-clockwise   → yaw rate is −ω.y
   */
  static toPilotAxes(omega: GyroSample, noiseRad = 0): AxisDemand {
    return {
      pitch: omega.x + noiseRad,
      roll: -omega.z + noiseRad * 0.6,
      yaw: -omega.y + noiseRad * 0.8,
    };
  }

  /**
   * Run one iteration of the cascade.
   *
   * @param stick      raw stick positions, −1..1
   * @param omega      body angular velocity, rad/s
   * @param tune       gains and rate profiles
   * @param authority  global multiplier (damage, failsafe), 0..1
   * @param gyroNoise  added gyro noise in rad (damaged board), 0 normally
   */
  step(
    dt: number,
    stick: { roll: number; pitch: number; yaw: number },
    omega: GyroSample,
    tune: TuningState,
    authority = 1,
    gyroNoise = 0,
  ): AxisDemand {
    // --- 1. Rates: stick → commanded rate setpoint ------------------------
    const setpoint = {
      roll: applyRates(tune.rates.roll, stick.roll) * DEG2RAD,
      pitch: applyRates(tune.rates.pitch, stick.pitch) * DEG2RAD,
      yaw: applyRates(tune.rates.yaw, stick.yaw) * DEG2RAD,
    };

    // Damaged gyro boards read noisily, so the controller has less idea what the
    // quad is really doing and copes worse — exactly what a cracked FC feels like.
    const actual = FlightController.toPilotAxes(omega, gyroNoise);

    const setpointRate = {
      roll: (setpoint.roll - this.prevSetpoint.roll) / Math.max(dt, 1e-5),
      pitch: (setpoint.pitch - this.prevSetpoint.pitch) / Math.max(dt, 1e-5),
      yaw: (setpoint.yaw - this.prevSetpoint.yaw) / Math.max(dt, 1e-5),
    };
    const gyroRate = {
      roll: (actual.roll - this.prevGyro.roll) / Math.max(dt, 1e-5),
      pitch: (actual.pitch - this.prevGyro.pitch) / Math.max(dt, 1e-5),
      yaw: (actual.yaw - this.prevGyro.yaw) / Math.max(dt, 1e-5),
    };

    // --- 2. P term: the main attitude demand -------------------------------
    const p = {
      roll: clamp((setpoint.roll - actual.roll) * tune.pid.roll.p * P_NORMALISE, -TERM_CLAMP, TERM_CLAMP),
      pitch: clamp((setpoint.pitch - actual.pitch) * tune.pid.pitch.p * P_NORMALISE, -TERM_CLAMP, TERM_CLAMP),
      yaw: clamp((setpoint.yaw - actual.yaw) * tune.pid.yaw.p * P_NORMALISE, -TERM_CLAMP, TERM_CLAMP),
    };

    // --- 3. Feedforward: reacts to the command changing --------------------
    const f = {
      roll: clamp(setpointRate.roll * (tune.pid.roll.f / 100) * F_NORMALISE, -TERM_CLAMP, TERM_CLAMP),
      pitch: clamp(setpointRate.pitch * (tune.pid.pitch.f / 100) * F_NORMALISE, -TERM_CLAMP, TERM_CLAMP),
      yaw: clamp(setpointRate.yaw * (tune.pid.yaw.f / 100) * F_NORMALISE, -TERM_CLAMP, TERM_CLAMP),
    };

    // --- 4. D term on the gyro measurement, not the error -----------------
    // Scaled by the D-term filter time constant: raising `dtermLowpassHz`
    // shortens the window over which the derivative is taken, which removes D
    // energy. That is exactly why a high D-term cutoff makes a tune oscillate.
    // Yaw normally carries no D term at all — it fights prop torque, not
    // airframe inertia, so there is nothing to damp.
    const dTau = 1 / (2 * Math.PI * Math.max(tune.filters.dtermLowpassHz, 20));
    const d = {
      roll: clamp(-gyroRate.roll * (tune.pid.roll.d / 100) * dTau, -TERM_CLAMP, TERM_CLAMP),
      pitch: clamp(-gyroRate.pitch * (tune.pid.pitch.d / 100) * dTau, -TERM_CLAMP, TERM_CLAMP),
      yaw: clamp(-gyroRate.yaw * (tune.pid.yaw.d / 100) * dTau, -TERM_CLAMP, TERM_CLAMP),
    };

    // --- 5. I term with anti-windup --------------------------------------
    const iLimit = 0.3;
    const integrate = (prev: number, error: number, gain: number): [number, boolean] => {
      const next = prev + error * gain * I_NORMALISE * dt;
      if (Math.abs(next) > iLimit) return [Math.sign(next) * iLimit, true];
      return [next, false];
    };
    const [iR, awR] = integrate(this.iRoll, setpoint.roll - actual.roll, tune.pid.roll.i);
    const [iP, awP] = integrate(this.iPitch, setpoint.pitch - actual.pitch, tune.pid.pitch.i);
    const [iY, awY] = integrate(this.iYaw, setpoint.yaw - actual.yaw, tune.pid.yaw.i);
    this.iRoll = iR;
    this.iPitch = iP;
    this.iYaw = iY;

    // --- Sum and normalise ------------------------------------------------
    const total = {
      roll: (p.roll + f.roll + iR + d.roll) * tune.rollAuthority * authority,
      pitch: (p.pitch + f.pitch + iP + d.pitch) * tune.pitchAuthority * authority,
      yaw: (p.yaw + f.yaw + iY + d.yaw) * tune.yawAuthority * authority,
    };

    // Demands saturate rather than wrapping, matching Betaflight's mixer limit.
    const demand = {
      roll: clamp(total.roll, -1, 1),
      pitch: clamp(total.pitch, -1, 1),
      yaw: clamp(total.yaw, -1, 1),
    };

    // Low-pass on the gyro used by the D term: a high cutoff here lets prop
    // vibration into the controller, which is the classic "chewy tune" symptom.
    const alpha = clamp(tune.filters.gyroLowpassHz * 2 * Math.PI * dt, 0, 1);
    this.prevGyro.roll += (actual.roll - this.prevGyro.roll) * alpha;
    this.prevGyro.pitch += (actual.pitch - this.prevGyro.pitch) * alpha;
    this.prevGyro.yaw += (actual.yaw - this.prevGyro.yaw) * alpha;
    this.prevSetpoint = { ...setpoint };

    this.debug = {
      setpointDegS: {
        roll: setpoint.roll * RAD2DEG,
        pitch: setpoint.pitch * RAD2DEG,
        yaw: setpoint.yaw * RAD2DEG,
      },
      actualDegS: {
        roll: actual.roll * RAD2DEG,
        pitch: actual.pitch * RAD2DEG,
        yaw: actual.yaw * RAD2DEG,
      },
      pTerm: p,
      iTerm: { roll: iR, pitch: iP, yaw: iY },
      dTerm: d,
      fTerm: f,
      antiWindup: awR || awP || awY,
    };

    return demand;
  }

  /** Advance the internal noise phase. Kept separate so it is reproducible. */
  tickNoise(dt: number): void {
    this.noisePhase += dt;
  }

  get phase(): number {
    return this.noisePhase;
  }
}

/** Convenience: build a rate profile from a max rate and expo. */
export const rateProfile = (center: number, max: number, expo: number): RateProfile => ({
  center,
  max,
  expo,
});
