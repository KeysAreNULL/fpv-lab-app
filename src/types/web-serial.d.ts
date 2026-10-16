/**
 * Ambient declarations for the Web Serial API.
 *
 * The DOM lib does not ship these yet, and adding `@types/w3c-web-serial` for
 * two methods is not worth the dependency. Only the surface this app uses is
 * declared, so an unsupported browser fails at runtime behind the
 * `RadioDriver.supported` guard rather than silently.
 */

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}

interface SerialPortRequestOptions {
  filters?: { usbVendorId?: number; usbProductId?: number }[];
}

interface Serial extends EventTarget {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

interface Navigator {
  readonly serial?: Serial;
}

interface HIDDevice extends EventTarget {
  open(): Promise<HID>;
  close(): Promise<void>;
}

interface HID extends EventTarget {
  readReports(length: number): Promise<DataView>;
}

interface HIDInputReportEvent extends Event {
  device: HIDDevice;
  reportId: number;
  data: DataView;
}

interface HIDConnectionEvent extends Event {
  device: HIDDevice;
}
