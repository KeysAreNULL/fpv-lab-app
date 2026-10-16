/**
 * Flight tuner — Betaflight-style PID and rate configuration.
 *
 * The tuning here is not cosmetic. `authority` scales the stick input before the
 * mixer, which is exactly what Betaflight's actual PID controller does: the
 * controller calculates a torque setpoint from the rate error and the stick
 * position, and the resulting authority depends on how hard the P term is
 * pushing. A build with low P authority feels vague and drifts in a way-up; a
 * build with high P authority snaps and then oscillates with too much D.
 *
 * Everything is exposed as named presets because that is how pilots actually
 * tune: start from a preset, change one number, feel the difference.
 */

export interface PidGains {
  /** Proportional — how hard the controller corrects attitude error. */
  p: number;
  /** Integral — removes steady-state drift, causes slow oscillations if too high. */
  i: number;
  /** Derivative — damps the response, amplifies gyro noise and vibration. */
  d: number;
  /** Feedforward — how much of the stick position is passed through directly. */
  f: number;
}

export interface RateProfile {
  /** Centre stick sensitivity, deg/s per 100% deflection. */
  center: number;
  /** Maximum stick rate, deg/s at full deflection. */
  max: number;
  /** Expo curve. 0 = linear, 1 = fully smoothed. */
  expo: number;
}

export interface TuningState {
  /** Per-axis PID gains. Betaflight uses P, I, D, F in this order. */
  pid: {
    roll: PidGains;
    pitch: PidGains;
    yaw: PidGains;
  };
  rates: {
    roll: RateProfile;
    pitch: RateProfile;
    yaw: RateProfile;
  };
  /** Filter cutoffs in Hz. Gyro noise and D-term feedback trade against each other. */
  filters: {
    /** Low-pass on the gyro feed to the PID loop. */
    gyroLowpassHz: number;
    /** Low-pass on the D-term. Lower = less vibration feedback, more lag. */
    dtermLowpassHz: number;
    /** Notch filters for frame resonance, centre frequency in Hz. */
    notchHz: number;
    notchQ: number;
  };
  /** Actual authority multipliers, derived from PID below. */
  rollAuthority: number;
  pitchAuthority: number;
  yawAuthority: number;
  /** Resonance frequency of this airframe, Hz — what the notch should target. */
  frameResonanceHz: number;
}

export interface TunePreset {
  id: string;
  name: string;
  description: string;
  /** Which airframe class this was dialled in on. */
  forClass: 'whoop' | 'cinewhoop' | 'inch5' | 'inch7';
  state: Omit<TuningState, 'rollAuthority' | 'pitchAuthority' | 'yawAuthority' | 'frameResonanceHz'>;
}

const gains = (p: number, i: number, d: number, f: number): PidGains => ({ p, i, d, f });

/**
 * Presets use Betaflight's real conventions (P ~40-90, D ~30-50, F ~90-130 for
 * 5" freestyle) so the numbers mean something to anyone who has tuned a quad.
 */
export const TUNE_PRESETS: readonly TunePreset[] = [
  {
    id: 'tune-smooth',
    name: 'Smooth Cinematic',
    description: 'Soft, film-like rates with heavy filtering. Best for scenic and long-range.',
    forClass: 'inch5',
    state: {
      pid: {
        roll: gains(38, 30, 30, 90),
        pitch: gains(40, 32, 32, 95),
        yaw: gains(45, 45, 0, 90),
      },
      rates: {
        roll: { center: 140, max: 420, expo: 0.4 },
        pitch: { center: 140, max: 420, expo: 0.4 },
        yaw: { center: 180, max: 480, expo: 0.3 },
      },
      filters: { gyroLowpassHz: 90, dtermLowpassHz: 70, notchHz: 180, notchQ: 2.5 },
    },
  },
  {
    id: 'tune-freestyle',
    name: 'Freestyle / Acro',
    description: 'Snappy, high D, low filter cutoffs. Built for flips, rolls and hard cuts.',
    forClass: 'inch5',
    state: {
      pid: {
        roll: gains(52, 40, 38, 110),
        pitch: gains(54, 42, 40, 115),
        yaw: gains(50, 50, 0, 110),
      },
      rates: {
        roll: { center: 180, max: 850, expo: 0.25 },
        pitch: { center: 180, max: 850, expo: 0.25 },
        yaw: { center: 200, max: 720, expo: 0.2 },
      },
      filters: { gyroLowpassHz: 110, dtermLowpassHz: 90, notchHz: 210, notchQ: 2 },
    },
  },
  {
    id: 'tune-race',
    name: 'Race',
    description: 'Balanced and fast. Moderate rates with enough D to stay locked in a corner.',
    forClass: 'inch5',
    state: {
      pid: {
        roll: gains(47, 38, 36, 125),
        pitch: gains(50, 40, 38, 130),
        yaw: gains(48, 48, 0, 120),
      },
      rates: {
        roll: { center: 200, max: 1100, expo: 0.18 },
        pitch: { center: 200, max: 1100, expo: 0.18 },
        yaw: { center: 220, max: 900, expo: 0.15 },
      },
      filters: { gyroLowpassHz: 120, dtermLowpassHz: 95, notchHz: 200, notchQ: 2.2 },
    },
  },
  {
    id: 'tune-whoop',
    name: 'Whoop',
    description: 'Very low mass, very high thrust-to-weight. Fast and twitchy by nature.',
    forClass: 'whoop',
    state: {
      pid: {
        roll: gains(48, 42, 36, 105),
        pitch: gains(50, 44, 38, 110),
        yaw: gains(45, 45, 0, 100),
      },
      rates: {
        roll: { center: 200, max: 950, expo: 0.2 },
        pitch: { center: 200, max: 950, expo: 0.2 },
        yaw: { center: 240, max: 800, expo: 0.18 },
      },
      filters: { gyroLowpassHz: 130, dtermLowpassHz: 100, notchHz: 260, notchQ: 2 },
    },
  },
  {
    id: 'tune-longrange',
    name: 'Long Range',
    description: 'Low rates and soft control. Keeps the nose steady in gusty air.',
    forClass: 'inch7',
    state: {
      pid: {
        roll: gains(35, 28, 26, 85),
        pitch: gains(37, 30, 28, 88),
        yaw: gains(42, 42, 0, 88),
      },
      rates: {
        roll: { center: 110, max: 320, expo: 0.5 },
        pitch: { center: 110, max: 320, expo: 0.5 },
        yaw: { center: 150, max: 380, expo: 0.4 },
      },
      filters: { gyroLowpassHz: 80, dtermLowpassHz: 60, notchHz: 150, notchQ: 3 },
    },
  },
];

/**
 * Frame resonance. The torsional mode of a quad frame scales roughly with the
 * square root of its stiffness-to-mass ratio, which for these sizes lands
 * between 110 Hz (a 7" with a soft stack) and 300 Hz (a rigid 5"). Getting the
 * notch filter on this frequency is the single most effective anti-vibration
 * step, and setting it to 120 Hz on a freestyle quad is why the tune feels
 * "chewy".
 */
export function frameResonance(
  wheelbaseM: number,
  auwKg: number,
  propDiameterM: number,
): number {
  // Thrust-weighted stiffness proxy: bigger prop = more disk area loading the
  // arms, which stiffens them; lighter frames ring higher.
  const armStiffness = Math.pow(propDiameterM, 2) * 900;
  const massPenalty = Math.pow(auwKg, 0.35);
  const sizePenalty = Math.pow(wheelbaseM, 0.5);
  return clampNumber(armStiffness / (massPenalty * sizePenalty * 120), 90, 340);
}

const clampNumber = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Convert PID gains into the authority multipliers the mixer uses.
 *
 * Betaflight's controller authority is roughly proportional to P·F for a given
 * error, then clamped. We model the saturating part so that raising P past the
 * point where the controller already commands full deflection stops doing
 * anything — which is exactly what happens on a real tune.
 */
function authorityFor(p: number, f: number, i: number): number {
  const raw = (p * f) / 4700 + i / 420;
  // Soft saturation: authority approaches but never exceeds ~1.6.
  return 1 + 0.6 * Math.tanh(raw - 0.35);
}

export function createDefaultTune(build: {
  frame: { frameClass: string; motorToMotorMm: number } | null;
  auwKg: number;
  propModel: { diameterM: number };
}): TuningState {
  const frameClass = (build.frame?.frameClass ?? 'inch5') as TunePreset['forClass'];
  const preset = TUNE_PRESETS.find((p) => p.forClass === frameClass) ?? TUNE_PRESETS[0];
  const resonance = build.frame
    ? frameResonance(build.frame.motorToMotorMm / 1000, build.auwKg, build.propModel.diameterM)
    : 190;

  const base: TuningState = {
    pid: structuredClone(preset.state.pid),
    rates: structuredClone(preset.state.rates),
    filters: { ...preset.state.filters, notchHz: resonance },
    rollAuthority: 1,
    pitchAuthority: 1,
    yawAuthority: 1,
    frameResonanceHz: resonance,
  };
  return applyAuthorities(base);
}

/** Re-derive the authority multipliers after any PID change. */
export function applyAuthorities(tune: TuningState): TuningState {
  tune.rollAuthority = authorityFor(tune.pid.roll.p, tune.pid.roll.f, tune.pid.roll.i);
  tune.pitchAuthority = authorityFor(tune.pid.pitch.p, tune.pid.pitch.f, tune.pid.pitch.i);
  // Yaw works differently — it fights prop torque rather than airframe inertia,
  // so it scales with P alone and is always the weakest axis.
  tune.yawAuthority = clampNumber(0.55 + tune.pid.yaw.p / 120 + tune.pid.yaw.f / 500, 0.3, 1.4);
  return tune;
}

/** Apply a preset on top of the current airframe. */
export function applyPreset(tune: TuningState, preset: TunePreset): TuningState {
  tune.pid = structuredClone(preset.state.pid);
  tune.rates = structuredClone(preset.state.rates);
  tune.filters = { ...preset.state.filters, notchHz: tune.frameResonanceHz };
  return applyAuthorities(tune);
}

/**
 * Re-target the filters when the build changes: the notch moves to the new
 * frame's resonance and the cutoffs scale with it.
 */
export function retune(tune: TuningState, build: { frame: { motorToMotorMm: number } | null; auwKg: number; propModel: { diameterM: number } }): TuningState {
  tune.frameResonanceHz = build.frame
    ? frameResonance(build.frame.motorToMotorMm / 1000, build.auwKg, build.propModel.diameterM)
    : 190;
  tune.filters.notchHz = tune.frameResonanceHz;
  // Heavier frames tolerate higher cutoffs; lighter ones need more filtering.
  const scale = clampNumber(build.auwKg / 0.65, 0.55, 1.5);
  tune.filters.gyroLowpassHz = Math.round(clampNumber(tune.filters.gyroLowpassHz * scale, 50, 200));
  tune.filters.dtermLowpassHz = Math.round(clampNumber(tune.filters.dtermLowpassHz * scale, 40, 180));
  return applyAuthorities(tune);
}

export type TuneAxis = 'roll' | 'pitch' | 'yaw';

/** Bounds for the UI sliders, matching what Betaflight will actually accept. */
export const PID_RANGES: Record<TuneAxis, Record<keyof PidGains, [number, number, number]>> = {
  roll: { p: [0, 120, 0.5], i: [0, 100, 0.5], d: [0, 100, 0.5], f: [0, 250, 1] },
  pitch: { p: [0, 120, 0.5], i: [0, 100, 0.5], d: [0, 100, 0.5], f: [0, 250, 1] },
  yaw: { p: [0, 150, 0.5], i: [0, 120, 0.5], d: [0, 100, 0.5], f: [0, 250, 1] },
};

export const RATE_RANGES: Record<TuneAxis, Record<keyof RateProfile, [number, number, number]>> = {
  roll: { center: [20, 400, 5], max: [100, 1600, 10], expo: [0, 1, 0.01] },
  pitch: { center: [20, 400, 5], max: [100, 1600, 10], expo: [0, 1, 0.01] },
  yaw: { center: [20, 400, 5], max: [100, 1600, 10], expo: [0, 1, 0.01] },
};

/**
 * Stick deflection to commanded rate, deg/s. Betaflight's actual "actual rates"
 * curve: expo blends between linear and a fully smoothed input.
 */
export function applyRates(profile: RateProfile, stick: number): number {
  const x = clampNumber(Math.abs(stick), 0, 1);
  const expoed = x * (profile.expo * x * x + (1 - profile.expo) * (3 - 2 * x) * 0.5 + profile.expo * 0.5);
  const t = clampNumber(expoed, 0, 1);
  // RC rate curve from centre to max.
  const rate = profile.center + (profile.max - profile.center) * t;
  return Math.sign(stick) * rate;
}

export interface TuneWarning {
  level: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * Static analysis of a tune. This is the "tuner" part of the tuner — it catches
 * the combinations that reliably produce a bad flight, which is more useful than
 * a row of sliders.
 */
export function analyseTune(tune: TuningState): TuneWarning[] {
  const out: TuneWarning[] = [];
  const { roll, pitch, yaw } = tune.pid;
  const resonance = tune.frameResonanceHz;
  const notch = tune.filters.notchHz;

  if (Math.abs(roll.p - pitch.p) > 12) {
    out.push({
      level: 'warning',
      message: 'Roll and pitch P differ by more than 12 — the quad will roll and pitch differently, which feels untidy.',
    });
  }
  if (roll.d > 60 && roll.i > 60) {
    out.push({
      level: 'warning',
      message: 'High D with high I: expect fast, low-frequency oscillation in a hard turn.',
    });
  }
  if (Math.abs(notch - resonance) > resonance * 0.35) {
    out.push({
      level: 'warning',
      message: `Notch filter is at ${notch.toFixed(0)} Hz but this frame resonates near ${resonance.toFixed(0)} Hz. Vibration will reach the D term.`,
    });
  }
  if (tune.filters.dtermLowpassHz > 140) {
    out.push({
      level: 'warning',
      message: 'D-term low-pass above 140 Hz will pass motor noise into the D term and cause chatter.',
    });
  }
  if (tune.rates.roll.max > 1400 && tune.filters.gyroLowpassHz < 90) {
    out.push({
      level: 'info',
      message: 'Very high rates with a low gyro filter: a noisy build will vibrate at these rates.',
    });
  }
  if (yaw.f > 130) {
    out.push({
      level: 'info',
      message: 'Yaw feedforward above 130 makes the quad twitch at throttle changes.',
    });
  }
  if (roll.p < 25) {
    out.push({
      level: 'error',
      message: 'Roll P below 25 will not hold attitude in a hard corner on a light build.',
    });
  }
  return out;
}
