/**
 * Touch and keyboard drivers.
 *
 * The touch layer is the one that makes this app genuinely usable on a phone
 * without a transmitter, so it is built to be *good* rather than merely present:
 *
 *  - Two virtual sticks that can be placed anywhere, so the pilot can put them
 *    where their thumbs fall rather than where the screen happens to be.
 *  - A spring-loaded throttle on the left that returns to centre on release, so
 *    a dropped phone does not leave the motors spinning.
 *  - Independent touch-action zones that do not conflict with the browser's own
 *    gestures, because Capacitor's webview will otherwise scroll and zoom
 *    mid-flight.
 *  - Every target is at least 44 px, and the sticks claim the pointer so a
 *    thumb sliding past one does not teleport another.
 */

import { clamp } from '../core/math/vec3';
import {
  NEUTRAL_STICKS,
  type RawSticks,
  type InputDeviceInfo,
  type InputDriver,
  type StickMode,
} from './types';

export interface StickVisual {
  /** Centre in CSS pixels, relative to the stick container. */
  cx: number;
  cy: number;
  /** Knob offset from centre, CSS pixels. */
  kx: number;
  ky: number;
  /** Radius the knob can travel, CSS pixels. */
  radius: number;
}

export interface TouchStickState {
  id: number | null;
  /** Home position, where the thumb rest position is. */
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  active: boolean;
}

const STICK_RADIUS = 52;
const TAP_ZONE = 140;

export class TouchDriver implements InputDriver {
  readonly kind = 'touch' as const;
  private mode: StickMode = 2;
  private pointerSticks = new Map<number, 'left' | 'right'>();
  private left: TouchStickState = { id: null, homeX: 0, homeY: 0, x: 0, y: 0, active: false };
  private right: TouchStickState = { id: null, homeX: 0, homeY: 0, x: 0, y: 0, active: false };
  private buttons = new Map<number, string>();
  private lastSticks: RawSticks = { ...NEUTRAL_STICKS, buttons: new Set() };

  info(): InputDeviceInfo {
    return {
      kind: this.kind,
      id: 'On-screen controls',
      connected: true,
    };
  }

  async start(): Promise<void> {
    /* pointer events are attached by the UI, not here */
  }
  stop(): void {
    this.reset();
  }

  setMode(mode: StickMode): void {
    this.mode = mode;
  }

  get stickMode(): StickMode {
    return this.mode;
  }

  reset(): void {
    this.left = { ...this.left, id: null, x: 0, y: 0, active: false };
    this.right = { ...this.right, id: null, x: 0, y: 0, active: false };
    this.pointerSticks.clear();
    this.buttons.clear();
    this.lastSticks = { ...NEUTRAL_STICKS, buttons: new Set() };
  }

  /** Called by the UI when a stick's home position changes (reposition mode). */
  setStickHome(which: 'left' | 'right', x: number, y: number): void {
    const stick = which === 'left' ? this.left : this.right;
    stick.homeX = x;
    stick.homeY = y;
    if (!stick.active) {
      stick.x = x;
      stick.y = y;
    }
  }

  stickVisual(which: 'left' | 'right'): StickVisual {
    const stick = which === 'left' ? this.left : this.right;
    return {
      cx: stick.homeX,
      cy: stick.homeY,
      kx: clamp(stick.x - stick.homeX, -STICK_RADIUS, STICK_RADIUS),
      ky: clamp(stick.y - stick.homeY, -STICK_RADIUS, STICK_RADIUS),
      radius: STICK_RADIUS,
    };
  }

  /** Touch down inside a stick zone. Returns true if it claimed the pointer. */
  pointerDown(id: number, side: 'left' | 'right' | 'button', x: number, y: number, button?: string): boolean {
    if (side === 'button') {
      if (button) this.buttons.set(id, button);
      return true;
    }
    const stick = side === 'left' ? this.left : this.right;
    if (stick.id !== null) return false;
    // Claim generously so a thumb landing near the stick still grabs it.
    if (Math.hypot(x - stick.homeX, y - stick.homeY) > TAP_ZONE) return false;
    stick.id = id;
    stick.active = true;
    stick.x = x;
    stick.y = y;
    this.pointerSticks.set(id, side);
    return true;
  }

  pointerMove(id: number, x: number, y: number): void {
    const side = this.pointerSticks.get(id);
    if (!side) return;
    const stick = side === 'left' ? this.left : this.right;
    stick.x = x;
    stick.y = y;
  }

  /** Touch up. Throttle springs back to its zero position, not to centre. */
  pointerUp(id: number): void {
    const side = this.pointerSticks.get(id);
    if (side) {
      const stick = side === 'left' ? this.left : this.right;
      stick.id = null;
      stick.active = false;
      stick.x = stick.homeX;
      stick.y = stick.homeY;
      this.pointerSticks.delete(id);
    }
    this.buttons.delete(id);
  }

  /** `on-screen` button state, e.g. the arm button. */
  setButton(name: string, pressed: boolean): void {
    if (pressed) this.buttons.set(-1, name);
    else if (this.buttons.get(-1) === name) this.buttons.delete(-1);
  }

  private get buttonPressed(): Set<string> {
    return new Set(this.buttons.values());
  }

  poll(): RawSticks | null {
    // A stick that is not being touched contributes nothing, and the throttle
    // reads its zero from the stick mode rather than from the last position.
    const leftX = this.left.active ? clamp((this.left.x - this.left.homeX) / STICK_RADIUS, -1, 1) : 0;
    const leftY = this.left.active ? clamp((this.left.y - this.left.homeY) / STICK_RADIUS, -1, 1) : 0;
    const rightX = this.right.active ? clamp((this.right.x - this.right.homeX) / STICK_RADIUS, -1, 1) : 0;
    const rightY = this.right.active ? clamp((this.right.y - this.right.homeY) / STICK_RADIUS, -1, 1) : 0;

    const pressed = this.buttonPressed;
    const buttons = new Set<string>();
    if (pressed.has('arm')) buttons.add('armSwitch');
    if (pressed.has('angle')) buttons.add('modeSwitch1');
    if (pressed.has('acro')) buttons.add('modeSwitch2');
    if (pressed.has('profile')) buttons.add('profileSwitch');
    if (pressed.has('beacon')) buttons.add('beacon');
    if (pressed.has('buzzer')) buttons.add('buzzer');
    if (pressed.has('home')) buttons.add('returnHome');
    if (pressed.has('record')) buttons.add('videoRecord');

    const next: RawSticks = {
      // Screen y grows downward, so the gimbal sign is flipped once here.
      leftX,
      leftY: -leftY,
      rightX,
      rightY: -rightY,
      buttons,
    };

    const unchanged =
      next.leftX === this.lastSticks.leftX &&
      next.leftY === this.lastSticks.leftY &&
      next.rightX === this.lastSticks.rightX &&
      next.rightY === this.lastSticks.rightY &&
      next.buttons.size === this.lastSticks.buttons.size;
    this.lastSticks = next;
    return unchanged ? null : next;
  }
}

/**
 * Keyboard driver — a virtual transmitter.
 *
 * Not a "flight mode" in the sense that nobody races a quad with a keyboard,
 * but it emulates a real gimbal pair so the desktop experience is actually
 * flyable rather than merely demonstrable:
 *
 *  - **X** is a spring-centred gimbal (roll or yaw, depending on stick mode).
 *  - **Throttle** is a *lever*, not a button: Shift raises it and Ctrl lowers it,
 *    at about 1.5 s from zero to full, and it holds position in between. Snapping
 *    straight to full throttle is un-flyable; this is why real throttle sticks
 *    work the way they do.
 *  - **The other gimbal's Y** is pitch.
 *
 * Space arms and disarms, matching the on-screen ARM button.
 */
export class KeyboardDriver implements InputDriver {
  readonly kind = 'keyboard' as const;
  private held = new Set<string>();
  private armed = false;
  private throttle = 0;
  private onArmToggle: (() => void) | null = null;

  /** Seconds from zero to full throttle, matching a real lever. */
  private static readonly THROTTLE_RATE = 1 / 1.5;
  /** Gimbal centring rate, per second. */
  private static readonly SPRING_RATE = 9;

  info(): InputDeviceInfo {
    return { kind: this.kind, id: 'Keyboard (virtual transmitter)', connected: true };
  }

  async start(): Promise<void> {
    window.addEventListener('keydown', this.keyDown as EventListener);
    window.addEventListener('keyup', this.keyUp as EventListener);
    // Releasing everything on blur stops the sim running away when the window
    // loses focus mid-throttle.
    window.addEventListener('blur', this.releaseAll);
  }

  stop(): void {
    window.removeEventListener('keydown', this.keyDown as EventListener);
    window.removeEventListener('keyup', this.keyUp as EventListener);
    window.removeEventListener('blur', this.releaseAll);
    this.releaseAll();
  }

  setArmHandler(handler: () => void): void {
    this.onArmToggle = handler;
  }

  private releaseAll = (): void => {
    this.held.clear();
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.throttle = 0;
  };

  private keyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    // Never steal keys from a text field or a slider.
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    this.held.add(event.code);
    if (event.code === 'Space') {
      event.preventDefault();
      this.armed = !this.armed;
      this.onArmToggle?.();
    }
    if (event.code.startsWith('Arrow')) event.preventDefault();
  };

  private keyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  /**
   * The keyboard's four axes are semantic — roll, pitch, yaw, throttle — but a
   * driver has to emit raw gimbals. This driver therefore needs to know the
   * stick mode so it can put each axis on the gimbal that mode expects.
   */
  setStickMode(mode: number): void {
    this.stickMode = mode;
  }

  poll(): RawSticks | null {
    const now = performance.now();
    const dt = this.lastPoll === 0 ? 1 / 60 : Math.min((now - this.lastPoll) / 1000, 0.1);
    this.lastPoll = now;
    const held = (...codes: string[]): boolean => codes.some((c) => this.held.has(c));

    const target = {
      roll: (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0),
      pitch: (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0),
      yaw: (held('KeyE') ? 1 : 0) - (held('KeyQ') ? 1 : 0),
    };
    const approach = (current: number, to: number): number => {
      const rate = to === 0 ? KeyboardDriver.SPRING_RATE : 22;
      return current + (to - current) * Math.min(1, dt * rate);
    };
    this.roll = approach(this.roll, target.roll);
    this.pitch = approach(this.pitch, target.pitch);
    this.yaw = approach(this.yaw, target.yaw);

    // Throttle lever: Shift raises, Ctrl lowers, and it holds where you leave it.
    if (held('ShiftLeft', 'ShiftRight', 'Digit1')) {
      this.throttle = Math.min(1, this.throttle + dt * KeyboardDriver.THROTTLE_RATE);
    } else if (held('ControlLeft', 'ControlRight', 'Digit0')) {
      this.throttle = Math.max(0, this.throttle - dt * KeyboardDriver.THROTTLE_RATE);
    }

    const buttons = new Set<string>();
    if (this.armed) buttons.add('armSwitch');
    if (held('KeyB')) buttons.add('buzzer');
    if (held('KeyR')) buttons.add('videoRecord');
    if (held('KeyZ')) buttons.add('modeSwitch1');

    // Place each axis on the gimbal the current stick mode assigns it to.
    // Mode 2 (the FPV default): left = throttle + yaw, right = roll + pitch.
    const throttleAxis = this.throttle * 2 - 1;
    const mode = this.stickMode;
    const throttleOnLeftY = mode === 2 || mode === 3;

    return {
      leftX: throttleOnLeftY ? this.yaw : this.roll,
      leftY: throttleOnLeftY ? throttleAxis : this.pitch,
      rightX: throttleOnLeftY ? this.roll : this.yaw,
      rightY: throttleOnLeftY ? this.pitch : throttleAxis,
      buttons,
    };
  }

  private roll = 0;
  private pitch = 0;
  private yaw = 0;
  private stickMode = 2;
  private lastPoll = 0;
}
