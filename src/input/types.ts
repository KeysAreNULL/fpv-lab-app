/**
 * Input contracts.
 *
 * Everything the simulation consumes is a normalised `ControlInput`; every
 * device is normalised to the same intermediate form before that. A RadioMaster
 * gimbal, a gamepad trigger and a thumb on a phone screen all become four
 * floats in [-1, 1] plus a throttle in [0, 1], and nothing downstream knows or
 * cares which produced them.
 */

import type { ControlInput } from '../core/physics/quadrotor';

/** The eight Betaflight control surfaces a pilot can assign. */
export type ControlSurface =
  | 'throttle'
  | 'roll'
  | 'pitch'
  | 'yaw'
  | 'armSwitch'
  | 'modeSwitch1'
  | 'modeSwitch2'
  | 'profileSwitch'
  | 'beacon'
  | 'buzzer'
  | 'returnHome'
  | 'videoRecord';

export const CONTROL_SURFACES: readonly ControlSurface[] = [
  'throttle',
  'roll',
  'pitch',
  'yaw',
  'armSwitch',
  'modeSwitch1',
  'modeSwitch2',
  'profileSwitch',
  'beacon',
  'buzzer',
  'returnHome',
  'videoRecord',
];

export const SURFACE_LABELS: Record<ControlSurface, string> = {
  throttle: 'Throttle',
  roll: 'Roll / Aileron',
  pitch: 'Pitch / Elevator',
  yaw: 'Yaw / Rudder',
  armSwitch: 'Arm Switch',
  modeSwitch1: 'Mode 1 (Angle/Horizon)',
  modeSwitch2: 'Mode 2 (Acro)',
  profileSwitch: 'Profile Select',
  beacon: 'Beacon',
  buzzer: 'Buzzer',
  returnHome: 'Return Home',
  videoRecord: 'Record Video',
};

/** What kind of physical input a binding refers to. */
export type BindingKind = 'axis' | 'button' | 'key' | 'touchZone' | 'channel';

export interface Binding {
  kind: BindingKind;
  /** Gamepad axis index, key code, button index, or touch zone id. */
  id: number | string;
  /** For axes: invert the direction. */
  inverted?: boolean;
  /** For buttons: which way they read (1 = pressed). */
  activeState?: number;
  /** Normalisation range for a 3-position switch, e.g. a 3-way gimbal. */
  positions?: 2 | 3;
}

export interface Mapping {
  surface: ControlSurface;
  binding: Binding | null;
}

export type StickMode = 1 | 2 | 3 | 4;

/** The normalised frame every device produces. */
export interface InputFrame {
  /** -1..1. */
  roll: number;
  pitch: number;
  yaw: number;
  /** 0..1 */
  throttle: number;
  /** Switch states. */
  switches: Record<SwitchSurface, boolean>;
}

/** The switch surfaces, i.e. the control surfaces that are booleans. */
export type SwitchSurface = Exclude<ControlSurface, 'roll' | 'pitch' | 'yaw' | 'throttle'>;

/** Switch lookup order, so the array form is stable. */
export const SWITCH_SURFACES: readonly SwitchSurface[] = [
  'armSwitch',
  'modeSwitch1',
  'modeSwitch2',
  'profileSwitch',
  'beacon',
  'buzzer',
  'returnHome',
  'videoRecord',
];

export const NEUTRAL_FRAME: InputFrame = {
  roll: 0,
  pitch: 0,
  yaw: 0,
  throttle: 0,
  switches: {
    armSwitch: false,
    modeSwitch1: false,
    modeSwitch2: false,
    profileSwitch: false,
    beacon: false,
    buzzer: false,
    returnHome: false,
    videoRecord: false,
  },
};

/** Convert a normalised frame into the physics input. */
export const toControlInput = (frame: InputFrame): ControlInput => ({
  roll: frame.roll,
  pitch: frame.pitch,
  yaw: frame.yaw,
  throttle: frame.throttle,
});

/** Build a frame from the switch map only, for the sim's snapshot. */
export const switchVector = (frame: InputFrame): boolean[] =>
  SWITCH_SURFACES.map((s) => frame.switches[s]);

export type InputDeviceKind = 'gamepad' | 'radio' | 'touch' | 'keyboard' | 'none';

/**
 * What a driver reports: two physical gimbals and a set of pressed buttons.
 *
 * Drivers deliberately do NOT apply stick modes. A stick mode is a property of
 * how the receiver is configured, not of the hardware, so exactly one place —
 * `InputManager` — turns gimbals into roll/pitch/yaw/throttle. That means a
 * RadioMaster in mode 2 and a gamepad in mode 2 go through identical code.
 */
export interface RawSticks {
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  /** Switch/surface names currently asserted, e.g. 'armSwitch'. */
  buttons: ReadonlySet<string>;
}

export const NEUTRAL_STICKS: RawSticks = {
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
  buttons: new Set<string>(),
};

export interface InputDeviceInfo {
  kind: InputDeviceKind;
  id: string;
  /** True while the device is producing usable data. */
  connected: boolean;
  /** For a radio, the detected protocol. */
  protocol?: string;
  /** Battery voltage reported by the device, if any. */
  batteryPercent?: number;
  /** Signal strength reported by the device, if any. */
  signalQuality?: number;
}

export interface InputDriver {
  readonly kind: InputDeviceKind;
  info(): InputDeviceInfo;
  /** Poll the device. Returns raw gimbals, or null if there is no new data. */
  poll(): RawSticks | null;
  start(): Promise<void>;
  stop(): void;
}
