/**
 * Gamepad driver (the Gamepad API).
 *
 * This covers three real cases:
 *  - a real transmitter with a USB joystick dongle, where axes 0–3 are the
 *    two gimbals in the order gimbal A X, gimbal A Y, gimbal B X, gimbal B Y;
 *  - a consumer gamepad, where axis 0 is the left stick X and axis 3 the right
 *    trigger, which is stick mode 1 by accident;
 *  - a phone or tablet with an on-screen gamepad overlay.
 *
 * The driver reports the raw axis/button list so the mapping UI can list real
 * control names instead of "Axis 3".
 */

import {
  SWITCH_SURFACES,
  type Binding,
  type ControlSurface,
  type InputDeviceInfo,
  type InputDriver,
  type Mapping,
  type RawSticks,
} from './types';

/**
 * Buttons 0–3 on a controller are the face buttons (A/B/X/Y). Pushing a
 * transmitter switch through a USB dongle normally lands on those, so the
 * control surfaces are mapped to the face buttons in the order below and the
 * mapping UI lets the pilot reassign them.
 */
const SURFACE_BUTTONS = SWITCH_SURFACES as readonly ControlSurface[];
const BASE_BUTTON = 0;

const DEADZONE = 0.06;
export class GamepadDriver implements InputDriver {
  readonly kind = 'gamepad' as const;
  private index: number | null = null;
  private connectedId = '';
  private batteryPercent: number | undefined;

  private readonly onConnect = (event: GamepadEvent) => {
    if (this.index === null) {
      this.index = event.gamepad.index;
      this.connectedId = event.gamepad.id;
    }
  };
  private readonly onDisconnect = (event: GamepadEvent) => {
    if (this.index === event.gamepad.index) {
      this.index = null;
      this.connectedId = '';
    }
  };

  async start(): Promise<void> {
    window.addEventListener('gamepadconnected', this.onConnect as EventListener);
    window.addEventListener('gamepaddisconnected', this.onDisconnect as EventListener);
    // Browsers only populate `navigator.getGamepads()` after a user gesture on
    // some platforms, and never report an already-connected pad until it is
    // polled, so just take the first one we find.
    this.index ??= firstConnectedIndex();
    const pad = this.index !== null ? navigator.getGamepads()[this.index] : null;
    if (pad) this.connectedId = pad.id;
  }

  stop(): void {
    window.removeEventListener('gamepadconnected', this.onConnect as EventListener);
    window.removeEventListener('gamepaddisconnected', this.onDisconnect as EventListener);
    this.index = null;
    this.connectedId = '';
  }

  info(): InputDeviceInfo {
    return {
      kind: this.kind,
      id: this.connectedId || 'No controller',
      connected: this.index !== null && this.connectedId.length > 0,
      batteryPercent: this.batteryPercent,
    };
  }

  poll(): RawSticks | null {
    const pad = this.index !== null ? navigator.getGamepads()[this.index] : null;
    if (!pad) return null;

    const axis = (i: number): number => {
      const value = pad.axes[i] ?? 0;
      if (Math.abs(value) < DEADZONE) return 0;
      return Math.sign(value) * ((Math.abs(value) - DEADZONE) / (1 - DEADZONE));
    };

    const buttons = new Set<string>();
    for (let i = 0; i < SURFACE_BUTTONS.length; i++) {
      const pressed = pad.buttons[i + BASE_BUTTON]?.pressed ?? false;
      if (pressed) buttons.add(SURFACE_BUTTONS[i]);
    }

    return {
      // Gimbals report Y up-positive, which is our convention, but the raw
      // Gamepad API is y-down, so the sign is flipped here — once, for every
      // device, rather than in each stick mode.
      leftX: axis(0),
      leftY: -axis(1),
      rightX: axis(2),
      rightY: -axis(3),
      buttons,
    };
  }

  /** Human-readable names for the mapping UI. */
  describeAxes(padIndex = this.index): { axis: string; buttons: string[] } {
    const pad = padIndex !== null ? navigator.getGamepads()[padIndex] : null;
    if (!pad) return { axis: 'No controller connected', buttons: [] };
    const axisNames = [
      'Gimbal A / Left Stick X',
      'Gimbal A / Left Stick Y',
      'Gimbal B / Right Stick X',
      'Gimbal B / Right Trigger',
    ];
    const axes = pad.axes.map((_, i) => axisNames[i] ?? `Axis ${i}`);
    const buttons = pad.buttons.map((_, i) => `Button ${i}`);
    return { axis: axes.join(', '), buttons };
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
void clamp01;

function firstConnectedIndex(): number | null {
  const pads = navigator.getGamepads?.() ?? [];
  for (let i = 0; i < pads.length; i++) if (pads[i]) return i;
  return null;
}

/**
 * Read a control surface from a gamepad given its binding.
 * Used by the mapping editor's "click to assign" capture step.
 */
export function readBinding(
  pad: Gamepad,
  binding: Binding | null,
  fallback: number = 0,
): number {
  if (!binding) return fallback;
  switch (binding.kind) {
    case 'axis':
      return pad.axes[binding.id as number] ?? 0;
    case 'button':
      return pad.buttons[binding.id as number]?.value ?? 0;
    default:
      return fallback;
  }
}

/** Which surface, if any, a freshly moved control should be assigned to. */
export function suggestSurface(
  mappings: Mapping[],
  kind: Binding['kind'],
  id: number | string,
): ControlSurface | null {
  const existing = mappings.find((m) => m.binding?.kind === kind && m.binding?.id === id);
  return existing ? existing.surface : null;
}
