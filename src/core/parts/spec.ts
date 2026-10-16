/**
 * Part specifications. Real-world datasheet data — see `catalog/` for the data
 * and AGENTS.md §7 for the rules on adding parts.
 *
 * UNITS: catalog stores the unit the datasheet quotes (note the field suffix).
 * Conversion to SI happens once, in `build/resolve.ts`. Never mix.
 */

/** Frame size class. Drives motor size, prop size and battery count. */
export type FrameClass = 'whoop' | 'cinewhoop' | 'inch5' | 'inch7';

/** Motor mounting bolt pattern, in millimetres. */
export type MotorMount = '9x9' | '12x12' | '14x14' | '16x16' | '19x19' | '22x22';

/** Flight-controller / stack mounting footprint. */
export type StackMount = 'whoop' | '20x20' | '20x30' | '30.5x30.5';

/** Video downlink technology. Analog and digital have fundamentally different failure modes. */
export type VideoLinkType = 'analog' | 'digital';

interface PartBase {
  readonly id: string;
  readonly brand: string;
  readonly name: string;
  readonly category: PartCategory;
  /** Mass in grams, as measured/quoted by the manufacturer. */
  readonly massGrams: number;
  /** Typical street price in USD. Drives the build cost readout. */
  readonly priceUsd: number;
  /**
   * Provenance of the numeric specs. Community-measured entries are real parts
   * whose numbers come from bench tests rather than a datasheet.
   */
  readonly specSource: 'datasheet' | 'community-measured';
}

export interface FramePart extends PartBase {
  readonly category: 'frame';
  readonly frameClass: FrameClass;
  /** Prop diameter this frame is designed around, in inches. */
  readonly propSizeInches: number;
  /** Motor-to-motor diagonal ("wheelbase") in millimetres. */
  readonly motorToMotorMm: number;
  /** Thrust demanded of each motor, used for arm-thickness sanity checks. */
  readonly maxMotorThrustGrams: number;
  readonly motorMount: MotorMount;
  readonly stackMount: StackMount;
  readonly motorScrewCount: 4 | 6;
  /** Arm thickness in mm — stiffer arms let bigger motors mount safely. */
  readonly armThicknessMm: number;
  /** Camera side plate width in mm (19/21/28mm determines VTX fit). */
  readonly cameraWidthMm: 14 | 19 | 21 | 28;
  readonly batterySlots: 1 | 2;
  readonly batteryFormat: 'slime' | 'standard' | 'xt60';
}

export interface MotorPart extends PartBase {
  readonly category: 'motor';
  /** Stator diameter x height, e.g. '2207'. */
  readonly statorSize: string;
  /** No-load speed constant. Ke = 60 / (2π · Kv) volts per rad/s. */
  readonly kvRpmPerVolt: number;
  /**
   * Effective phase resistance in milli-ohms, as seen by the motor model.
   *
   * This is deliberately *higher* than the DC winding resistance on a
   * milliohm-meter (which is what some datasheets quote). It is the loaded
   * value including stator AC losses, cabling and ESC drops, calibrated so
   * simulated operating points match published field data — e.g. a 5" quad on
   * 6S 1750KV hovers at ~40% throttle / ~40 A and pulls ~110 A at full
   * throttle with ~2.1 kgf of static thrust. Use this value, not a datasheet DC
   * figure, or the motor model has no self-consistent solution.
   */
  readonly phaseResistanceMilliOhm: number;
  readonly maxCurrentAmps: number;
  /** Manufacturer-quoted max thrust in grams, at `maxThrustVolts`. */
  readonly maxThrustGrams: number;
  readonly maxThrustVolts: number;
  /** Rotor + bell inertia about the spin axis, kg·m². */
  readonly rotorInertiaKgM2: number;
  readonly bellDiameterMm: number;
  readonly bellHeightMm: number;
  readonly shaftDiameterMm: 1.5 | 5;
  readonly mount: MotorMount;
  /** KV is measured with no load; loaded KV runs lower. ~0.90 for normal outrunners. */
  readonly loadedKvFactor: number;
}

export interface PropPart extends PartBase {
  readonly category: 'prop';
  readonly diameterInches: number;
  readonly pitchInches: number;
  readonly bladeCount: 2 | 3 | 4;
  /**
   * Static figure of merit — induced power as a fraction of shaft power at a
   * standing hover. Real props sit between 0.55 and 0.65; the prop model derives
   * thrust and torque coefficients from pitch ratio, and this sets how much of
   * the mechanical power actually becomes thrust.
   */
  readonly figureOfMerit: number;
  readonly hubDiameterInches: number;
  /** Scale on the blade drag area — thin blades lose efficiency when wet or damaged. */
  readonly profileDragScale: number;
}

/** Combined flight-controller + 4-in-1 ESC stack. */
export interface StackPart extends PartBase {
  readonly category: 'stack';
  readonly mcu: string;
  readonly gyro: string;
  readonly escProtocol: 'BLHeli_32' | 'AM32';
  readonly maxContinuousAmps: number;
  readonly maxBurstAmps: number;
  readonly inputVoltageMin: number;
  readonly inputVoltageMax: number;
  readonly mount: StackMount;
  readonly motorMount: MotorMount;
  readonly onboardBlackbox: boolean;
  /** Receiver protocol the flight controller can bind to. */
  readonly protocols: readonly ControlProtocol[];
  readonly uartCount: number;
}

export interface FcPart extends PartBase {
  readonly category: 'fc';
  readonly mcu: string;
  readonly gyro: string;
  readonly mount: StackMount;
  readonly motorMount: MotorMount;
  readonly onboardBlackbox: boolean;
  readonly protocols: readonly ControlProtocol[];
  readonly uartCount: number;
  readonly inputVoltageMax: number;
}

export interface EscPart extends PartBase {
  readonly category: 'esc';
  readonly protocol: 'BLHeli_32' | 'AM32';
  readonly maxContinuousAmps: number;
  readonly maxBurstAmps: number;
  readonly inputVoltageMin: number;
  readonly inputVoltageMax: number;
  readonly mount: StackMount;
  readonly motorMount: MotorMount;
  /** PWM frequency in kHz. High = less whine, more heat, more compatible firmware. */
  readonly pwmKhz: 24 | 48 | 96;
}

export interface VtxPart extends PartBase {
  readonly category: 'vtx';
  readonly linkType: VideoLinkType;
  readonly frequencyBandMhz: 2400 | 5800;
  readonly outputMilliwatts: number;
  /** Digital only: the built-in camera sensor. Analog VTXes have no camera. */
  readonly integratedCamera: DigitalCameraSpec | null;
  readonly channels: number;
  /** SmartAudio / Tramp — lets the OSD change power/frequency. */
  readonly smartAudio: boolean;
  readonly inputVoltageMin: number;
  readonly inputVoltageMax: number;
  readonly cooling: 'passive' | 'active';
  /** Digital link latency budget in ms — the reason digital wins at racing. */
  readonly latencyMs: number;
  readonly maxResolution: string;
}

export interface CameraPart extends PartBase {
  readonly category: 'camera';
  readonly linkType: VideoLinkType;
  readonly tvl: number;
  readonly sensor: string;
  readonly sensorSizeInches: number;
  readonly lensMount: 'M8' | 'M9' | 'M12';
  readonly widthMm: 14 | 19 | 21;
  readonly latencyMs: number;
  readonly wideDynamicRange: boolean;
}

export interface DigitalCameraSpec {
  readonly tvl: number;
  readonly sensor: string;
  readonly sensorSizeInches: number;
  readonly maxResolution: string;
  readonly fps: number;
}

export interface LensPart extends PartBase {
  readonly category: 'lens';
  readonly focalLengthMm: number;
  readonly sensorSizeInches: number;
  readonly apertureFStop: number;
  readonly throwRatio: number;
  readonly mount: 'M8' | 'M9' | 'M12';
}

export interface RxPart extends PartBase {
  readonly category: 'rx';
  readonly protocol: ControlProtocol;
  readonly frequencyBandMhz: 2400 | 5800 | 900 | 868;
  /** Transmit power in dBm. 20 dBm = 100 mW. */
  readonly txPowerDbm: number;
  /** Receiver sensitivity in dBm — more negative is better. */
  readonly sensitivityDbm: number;
  /** Antenna diversity: true when the RX has two switched RF paths. */
  readonly diversity: boolean;
  readonly refreshRateHz: number;
}

export interface TxRadioPart extends PartBase {
  readonly category: 'tx';
  readonly protocol: ControlProtocol;
  readonly frequencyBandMhz: 2400 | 900 | 868;
  readonly txPowerDbm: number;
  readonly channels: number;
  readonly touchScreen: boolean;
  readonly hallEffectGimbals: boolean;
  readonly expressLrsFirmware: boolean;
}

export interface BatteryPart extends PartBase {
  readonly category: 'battery';
  readonly cells: 1 | 2 | 3 | 4 | 6 | 8;
  readonly capacityMah: number;
  readonly cRating: number;
  readonly cellType: '18650' | '21700' | '1050' | '18650-lipo' | 'pouch';
  /** Pack internal resistance in milli-ohms. The single biggest sag driver. */
  readonly packResistanceMilliOhm: number;
  readonly nominalVoltage: number;
  readonly maxVoltage: number;
  readonly minVoltagePerCell: number;
  readonly connector: 'XT30' | 'XT60' | 'XT90' | 'PH2.0' | 'Sprint 2';
  readonly burstDischargeAmps: number;
}

export interface AntennaPart extends PartBase {
  readonly category: 'antenna';
  readonly bandMhz: 5800 | 2400 | 900;
  readonly gainDbi: number;
  readonly polarization: 'linear' | 'circular' | 'biconical';
  readonly connector: 'SMA' | 'MMCX' | 'RP-SMA' | 'U.FL';
}

export interface GpsPart extends PartBase {
  readonly category: 'gps';
  readonly chipset: string;
  readonly updateRateHz: number;
  readonly supportsGlonass: boolean;
  readonly compass: boolean;
}

export type Part =
  | FramePart
  | MotorPart
  | PropPart
  | StackPart
  | FcPart
  | EscPart
  | VtxPart
  | CameraPart
  | LensPart
  | RxPart
  | TxRadioPart
  | BatteryPart
  | AntennaPart
  | GpsPart;

export type PartCategory = Part['category'];

/** Control-link protocols. Each fails differently, so the sim models them separately. */
export type ControlProtocol = 'expresslrs' | 'crossfire' | 'tracer' | 'ghst' | 'elrs868' | 'elrs900';

/** Slots a build fills. `propA`/`propB` are the tri-blade/quad-blade halves of a quad. */
export type PartSlot =
  | 'frame'
  | 'motor'
  | 'fc'
  | 'esc'
  | 'stack'
  | 'vtx'
  | 'camera'
  | 'lens'
  | 'rx'
  | 'tx'
  | 'antenna'
  | 'propA'
  | 'propB'
  | 'battery1'
  | 'battery2'
  | 'gps';

/** Slots that hold exactly one part, used for builder layout and validation. */
export const SINGLE_SLOTS: readonly PartSlot[] = [
  'frame',
  'motor',
  'fc',
  'esc',
  'stack',
  'vtx',
  'camera',
  'lens',
  'rx',
  'tx',
  'antenna',
  'gps',
];

/** Slots that are installed in multiples (one per motor / per pack). */
export const REPEATED_SLOTS: readonly PartSlot[] = ['propA', 'propB', 'battery1', 'battery2'];

/** Parts inside a digital VTX that replace the separate camera slot. */
export const VTX_BUILTIN = true;
