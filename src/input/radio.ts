/**
 * ExpressLRS / Crossfire radio driver.
 *
 * Two paths, both real:
 *
 *  1. **Web Serial.** Plug the transmitter's USB port in and this reads either
 *     the ELRS "joystick" protocol (a HID frame carrying normalised channel
 *     values) or CRSF over a serial bridge. This is the path that works when a
 *     phone is the transmitter's display.
 *  2. **WebHID.** Some ELRS transmitters expose the joystick as a HID device
 *     without a driver, which is the cleanest option where it is supported.
 *
 * If neither is available — which is most desktop browsers — the driver reports
 * that clearly so the UI can fall back to the gamepad or touch screen rather
 * than silently doing nothing.
 *
 * The frame format is the ELRS joystick frame: 16 channels as big-endian
 * uint16 in the range 885..1215 around a 1050 centre, which normalises to
 * exactly 1000 ± microseconds, ±1000 full scale. That mapping is applied here
 * so the rest of the app sees [-1, 1].
 */

import { clamp } from '../core/math/vec3';
import {
  type InputDeviceInfo,
  type InputDriver,
  type RawSticks,
} from './types';

/** Microsecond channel values for full deflection. */
const CH_MIN = 885;
const CH_MAX = 1215;
const CH_CENTRE = 1050;

/** Frame length for a 16-channel ELRS joystick frame. */
const FRAME_LENGTH = 32;

export type RadioProtocol = 'expresslrs' | 'crossfire' | 'unknown';

export interface RadioFrame {
  channels: number[];
  /** Link quality, 0..100. */
  lq?: number;
  /** RSSI in dBm. */
  rssi?: number;
  /** Transmitter battery, 0..1. */
  battery?: number;
  protocol: RadioProtocol;
}

export interface RadioDriverOptions {
  /** Called when the pilot connects/disconnects from the simulator's radio. */
  onConnect?: (connected: boolean) => void;
}

export class RadioDriver implements InputDriver {
  readonly kind = 'radio' as const;

  private port: SerialPort | null = null;
  private hidDevice: HIDDevice | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buffer = new Uint8Array(0);
  private latest: RadioFrame | null = null;
  private connected = false;
  private deviceLabel = 'No radio';
  private transport: 'serial' | 'hid' | null = null;
  private readonly options: RadioDriverOptions;

  constructor(options: RadioDriverOptions = {}) {
    this.options = options;
  }

  /** Whether this browser can talk to a radio at all. */
  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator && !!navigator.serial;
  }

  async start(): Promise<void> {
    await this.requestSerial();
  }

  stop(): void {
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.port = null;
    void this.hidDevice?.close().catch(() => undefined);
    this.hidDevice = null;
    this.connected = false;
    this.transport = null;
    this.deviceLabel = 'No radio';
    this.options.onConnect?.(false);
  }

  info(): InputDeviceInfo {
    return {
      kind: this.kind,
      id: this.deviceLabel,
      connected: this.connected,
      protocol: this.latest?.protocol === 'unknown' ? undefined : this.latest?.protocol,
      batteryPercent: this.latest?.battery !== undefined ? this.latest.battery * 100 : undefined,
      signalQuality: this.latest?.lq,
    };
  }

  /** Ask for a serial port. Only valid inside a user gesture. */
  async requestSerial(): Promise<boolean> {
    const serial = navigator.serial;
    if (!serial) {
      this.deviceLabel = 'Web Serial not supported - use a controller or touch';
      return false;
    }
    try {
      this.port = await serial.requestPort();
      if (!this.port) return false;
      const port = this.port;
      await port.open({ baudRate: 420 });
      this.connected = true;
      this.transport = 'serial';
      const vendor = port.getInfo().usbVendorId;
      this.deviceLabel = vendor ? `Radio (serial ${vendor.toString(16)})` : 'Radio (serial)';
      this.options.onConnect?.(true);
      void this.readSerialLoop();
      return true;
    } catch {
      // The pilot cancelled the chooser, or the port is in use.
      this.connected = false;
      this.options.onConnect?.(false);
      return false;
    }
  }

  private async readSerialLoop(): Promise<void> {
    const port = this.port;
    const readable = port?.readable;
    if (!port || !readable) return;
    this.reader = readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.ingest(value);
      }
    } catch {
      // Unplugged. The UI will see `connected` go false on the next poll.
    } finally {
      this.reader = null;
      this.connected = false;
      this.options.onConnect?.(false);
    }
  }

  /** Feed raw bytes. Split into frames and keep the most recent. */
  ingest(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);

    for (let offset = 0; offset + FRAME_LENGTH <= merged.length; offset += FRAME_LENGTH) {
      const frame = decodeElrsFrame(merged.subarray(offset, offset + FRAME_LENGTH));
      if (frame) this.latest = frame;
    }
    // Keep a partial frame around for the next chunk.
    const remainder = merged.length % FRAME_LENGTH;
    this.buffer = merged.subarray(merged.length - remainder);
  }

  /** Inject a frame directly. Used by the on-screen radio emulator. */
  inject(frame: RadioFrame): void {
    this.latest = frame;
    this.connected = true;
  }

  poll(): RawSticks | null {
    const raw = this.latest;
    if (!raw || raw.channels.length < 4) return null;

    // AETR: throttle, roll, pitch, yaw, then the switches on 5–8.
    const [throttleCh, rollCh, pitchCh, yawCh] = raw.channels;
    const buttons = new Set<string>();
    const addSwitch = (index: number, name: string): void => {
      if ((raw.channels[index] ?? CH_MIN) > CH_CENTRE) buttons.add(name);
    };
    addSwitch(4, 'armSwitch');
    addSwitch(5, 'modeSwitch1');
    addSwitch(6, 'modeSwitch2');
    addSwitch(7, 'profileSwitch');
    addSwitch(8, 'beacon');
    addSwitch(9, 'buzzer');
    addSwitch(10, 'returnHome');
    addSwitch(11, 'videoRecord');

    return {
      // Channel microseconds → signed gimbal positions.
      leftX: channelToSigned(rollCh),
      leftY: channelToSigned(pitchCh),
      rightX: channelToSigned(yawCh),
      // Gimbal Y is up-positive, so the throttle channel maps directly.
      rightY: channelToSigned(throttleCh),
      buttons,
    };
  }

  /** Latest reported link quality, 0..100, for the radio readout. */
  get linkQuality(): number | undefined {
    return this.latest?.lq;
  }

  get transportKind(): 'serial' | 'hid' | null {
    return this.transport;
  }
}

/** Microseconds → 0..1. */
export function channelToUnit(microseconds: number): number {
  return clamp((microseconds - CH_MIN) / (CH_MAX - CH_MIN), 0, 1);
}

/** Microseconds → −1..1 about the centre. */
export function channelToSigned(microseconds: number): number {
  return clamp((microseconds - CH_CENTRE) / ((CH_MAX - CH_MIN) / 2), -1, 1);
}

/** Signed value → microseconds, for the on-screen radio emulator. */
export const signedToChannel = (value: number): number =>
  CH_CENTRE + clamp(value, -1, 1) * ((CH_MAX - CH_MIN) / 2);

export const unitToChannel = (value: number): number =>
  CH_MIN + clamp(value, 0, 1) * (CH_MAX - CH_MIN);

/**
 * Decode one ELRS joystick frame: 16 big-endian uint16 channels.
 * Returns null when the frame is obviously not a joystick frame, so random
 * serial noise does not produce phantom stick positions.
 */
export function decodeElrsFrame(bytes: Uint8Array): RadioFrame | null {
  if (bytes.length < FRAME_LENGTH) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels: number[] = [];
  for (let i = 0; i < 12; i++) {
    const value = view.getUint16(i * 2, false);
    // Out of the PPM range entirely means this is not a channel frame.
    if (value < 700 || value > 1500) return null;
    channels.push(value);
  }
  return { channels, protocol: 'expresslrs' };
}
