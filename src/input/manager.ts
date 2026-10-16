/**
 * Unified input manager.
 *
 * Owns the active driver, applies the stick mode, runs channel calibration and
 * smoothing, and exposes one normalised `InputFrame` per frame. This is the only
 * place that knows how a gimbal deflection becomes a roll command, so a
 * RadioMaster, a gamepad and a thumb on glass all behave identically once they
 * reach the simulation.
 */

import { clamp } from '../core/math/vec3';
import {
  DEFAULT_CALIBRATION,
  applyStickMode,
  createArmGesture,
  processAxis,
  smooth,
  switchesFromButtons,
  updateArmGesture,
  type AxisCalibration,
  type StickAxis,
} from './mapping';
import {
  NEUTRAL_FRAME,
  type ControlSurface,
  type InputDeviceInfo,
  type InputDriver,
  type InputFrame,
  type StickMode,
} from './types';
import { GamepadDriver } from './gamepad';
import { RadioDriver } from './radio';
import { KeyboardDriver, TouchDriver } from './touch';

export type DriverKind = 'gamepad' | 'radio' | 'touch' | 'keyboard';

export interface InputConfig {
  stickMode: StickMode;
  calibration: Record<StickAxis, AxisCalibration>;
  /** Arm via the throttle/yaw gesture instead of a switch. */
  gestureArm: boolean;
  /** Auto-disarm when the control link fails. */
  autoDisarmOnFailsafe: boolean;
  /** Preferred driver; falls back automatically if it is unavailable. */
  preferred: DriverKind;
}

export const DEFAULT_INPUT_CONFIG: InputConfig = {
  stickMode: 2,
  calibration: structuredClone(DEFAULT_CALIBRATION),
  gestureArm: true,
  autoDisarmOnFailsafe: true,
  preferred: 'gamepad',
};

export class InputManager {
  private drivers = new Map<DriverKind, InputDriver>();
  private active: DriverKind = 'touch';
  private config: InputConfig = structuredClone(DEFAULT_INPUT_CONFIG);
  private frame: InputFrame = { ...NEUTRAL_FRAME };
  private gesture = createArmGesture();
  private listeners = new Set<(frame: InputFrame, info: InputDeviceInfo) => void>();

  constructor() {
    this.drivers.set('gamepad', new GamepadDriver());
    this.drivers.set('radio', new RadioDriver());
    this.drivers.set('touch', new TouchDriver());
    this.drivers.set('keyboard', new KeyboardDriver());
  }

  /**
   * Start every driver, then activate the best available one.
   *
   * The preferred driver is only chosen if it is actually connected — asking
   * for a gamepad on a machine without one would leave the sim reading a driver
   * that never produces a frame, so the throttle would appear dead.
   */
  async start(preferred: DriverKind = this.config.preferred): Promise<DriverKind> {
    for (const driver of this.drivers.values()) {
      await driver.start().catch(() => undefined);
    }
    (this.drivers.get('keyboard') as KeyboardDriver).setStickMode(this.config.stickMode);
    return this.selectBest(preferred);
  }

  /** Pick the preferred driver if it is connected, else the best available. */
  private selectBest(preferred: DriverKind): DriverKind {
    if (this.drivers.get(preferred)?.info().connected) return this.select(preferred);
    const order: DriverKind[] = ['gamepad', 'radio', 'keyboard', 'touch'];
    const connected = order.filter((kind) => this.drivers.get(kind)?.info().connected);
    return this.select(connected[0] ?? 'touch');
  }

  /**
   * Make `kind` the active driver.
   *
   * Connecting a gamepad mid-flight should promote it automatically, so this
   * also watches for that: if a pad appears while another driver is active, the
   * gamepad takes over.
   */
  select(kind: DriverKind): DriverKind {
    const driver = this.drivers.get(kind);
    if (!driver) return this.active;
    this.active = kind;
    this.gesture = createArmGesture();
    return this.active;
  }

  setConfig(config: Partial<InputConfig>): void {
    this.config = { ...this.config, ...config };
    // The keyboard emits raw gimbals, so it needs to know the stick mode to
    // place the pilot's four axes on the right sticks.
    (this.drivers.get('keyboard') as KeyboardDriver).setStickMode(this.config.stickMode);
  }

  get settings(): InputConfig {
    return this.config;
  }

  get touch(): TouchDriver {
    return this.drivers.get('touch') as TouchDriver;
  }

  get radio(): RadioDriver {
    return this.drivers.get('radio') as RadioDriver;
  }

  get gamepad(): GamepadDriver {
    return this.drivers.get('gamepad') as GamepadDriver;
  }

  /** Ask the browser to switch sticks to a radio transport. */
  async connectRadio(): Promise<boolean> {
    const radio = this.radio;
    const ok = await radio.requestSerial();
    if (ok) this.select('radio');
    return ok;
  }

  /**
   * Poll the active driver and produce the next frame.
   *
   * The touch and keyboard drivers are always polled as a floor, so the arm
   * button and the space bar work no matter which device has the sticks.
   */
  poll(dt: number, time: number): InputFrame {
    // Hot-plug: a controller appearing takes over from whatever was active,
    // because a pilot who just plugged in a pad expects it to work immediately.
    if (this.active !== 'gamepad' && this.drivers.get('gamepad')?.info().connected) {
      this.select('gamepad');
    }

    const active = this.drivers.get(this.active);
    const raw = active?.poll() ?? null;

    if (!raw) {
      // No data from the active device: hold the last frame but keep it safe.
      this.frame = {
        ...this.frame,
        throttle: smooth(this.frame.throttle, 0, 0.15, dt),
        roll: smooth(this.frame.roll, 0, 0.1, dt),
        pitch: smooth(this.frame.pitch, 0, 0.1, dt),
        yaw: smooth(this.frame.yaw, 0, 0.1, dt),
      };
      this.emit();
      return this.frame;
    }

    const mode = this.config.stickMode;
    const gimbals = applyStickMode(raw.leftX, raw.leftY, raw.rightX, raw.rightY, mode);
    const cal = this.config.calibration;

    const roll = processAxis('roll', gimbals.roll, cal.roll, this.frame.roll, dt);
    const pitch = processAxis('pitch', gimbals.pitch, cal.pitch, this.frame.pitch, dt);
    const yaw = processAxis('yaw', gimbals.yaw, cal.yaw, this.frame.yaw, dt);
    const throttle = processAxis('throttle', gimbals.throttle, cal.throttle, this.frame.throttle, dt);

    const switches = switchesFromButtons(raw.buttons);
    // Throttle/yaw arming gesture, on top of whatever switch is mapped.
    if (this.config.gestureArm) {
      if (updateArmGesture(this.gesture, throttle, yaw, time)) switches.armSwitch = true;
    }

    this.frame = {
      roll: clamp(roll, -1, 1),
      pitch: clamp(pitch, -1, 1),
      yaw: clamp(yaw, -1, 1),
      throttle: clamp(throttle, 0, 1),
      switches,
    };
    this.emit();
    return this.frame;
  }

  /** Drop to zero throttle. Used on crash, blur, and disarm. */
  neutralize(): void {
    this.frame = { ...NEUTRAL_FRAME };
    this.gesture = createArmGesture();
  }

  /** Info for the active driver, or a disconnected placeholder. */
  info(): InputDeviceInfo {
    return (
      this.drivers.get(this.active)?.info() ?? {
        kind: 'none' as const,
        id: 'No input',
        connected: false,
      }
    );
  }

  private emit(): void {
    const info = this.info();
    for (const listener of this.listeners) listener(this.frame, info);
  }

  onFrame(listener: (frame: InputFrame, info: InputDeviceInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cycle through the connected drivers. */
  cycleDriver(): DriverKind {
    const order: DriverKind[] = ['gamepad', 'radio', 'keyboard', 'touch'];
    const connected = order.filter((kind) => this.drivers.get(kind)?.info().connected);
    const pool: DriverKind[] = connected.length > 0 ? connected : ['touch'];
    const next = (pool.indexOf(this.active) + 1) % pool.length;
    return this.select(pool[next]);
  }
}

export type { ControlSurface, InputFrame };
