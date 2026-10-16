/**
 * Turns a `BuildSpec` into everything the simulator needs: mass distribution,
 * centre of gravity, inertia tensor, mixer geometry, electrical ceilings and the
 * aerodynamic reference areas used by the drag model.
 *
 * This is the only place catalog datasheet units are converted to SI.
 */

import { GRAVITY, gramsToKg, inchToMeter } from '../constants';
import { findPart } from '../parts';
import type { BuildSpec } from '../parts/presets';
import type {
  BatteryPart,
  ControlProtocol,
  FramePart,
  MotorPart,
  Part,
  PropPart,
  VideoLinkType,
} from '../parts/spec';
import { buildPropModel, type PropModel } from '../physics/prop';
import type { Mat3 } from '../math/quat';
import type { Vec3 } from '../math/vec3';

/**
 * Component layout in the body frame, metres. +X right, +Y up, +Z forward.
 * Positions are approximate but dimensionally right; the renderer uses the same
 * table so the mesh and the physics can never disagree.
 */
export const LAYOUT = {
  stack: { x: 0, y: -0.004, z: 0 },
  vtx: { x: 0, y: 0.006, z: 0.055 },
  camera: { x: 0, y: 0.019, z: 0.062 },
  lens: { x: 0, y: 0.019, z: 0.068 },
  antenna: { x: 0, y: 0.012, z: -0.03 },
  rx: { x: 0, y: -0.012, z: -0.04 },
  gps: { x: 0, y: -0.014, z: -0.045 },
  /** Battery sits below and behind the CG, which is why battery sag pitches you forward. */
  battery: { x: 0, y: -0.032, z: -0.018 },
  battery2: { x: 0, y: -0.032, z: -0.062 },
} as const satisfies Record<string, Vec3>;

/** Motor mount points, in Betaflight numbering. */
export const MOTOR_ORDER = ['rear-right', 'front-right', 'rear-left', 'front-left'] as const;
export type MotorName = (typeof MOTOR_ORDER)[number];

/**
 * Rotation direction: -1 spins clockwise viewed from above (rear-right and
 * front-left), +1 spins counter-clockwise. This is the standard quad-X layout.
 */
export const MOTOR_SPIN: readonly [number, number, number, number] = [-1, 1, 1, -1];

export interface MotorPlacement {
  index: number;
  name: MotorName;
  /** Body-frame mount position, metres. */
  position: Vec3;
  /** -1 clockwise from above, +1 counter-clockwise. */
  spin: number;
}

export interface ResolvedBuild {
  readonly spec: BuildSpec;
  /** All-up weight in kilograms, including battery. */
  readonly auwKg: number;
  /** Centre of gravity in the body frame, metres. */
  readonly cg: Vec3;
  /** Inertia tensor in the body frame, kg·m². */
  readonly inertia: Mat3;
  /** Motor-to-motor diagonal, metres. */
  readonly wheelbaseM: number;
  /** Horizontal distance from CG to each motor, metres. */
  readonly armM: number;
  readonly motors: readonly MotorPlacement[];
  readonly propModel: PropModel;
  readonly propMassKg: number;
  readonly motorInertiaKgM2: number;
  readonly frame: FramePart | null;
  readonly motor: MotorPart | null;
  readonly battery: BatteryPart | null;
  /** Number of battery packs actually carried. */
  readonly batteryCount: number;
  readonly totalPriceUsd: number;
  readonly electrical: ElectricalSummary;
  readonly aero: AeroSummary;
  readonly video: VideoSummary;
  readonly control: ControlSummary;
  /** Per-component mass breakdown for the builder readout. */
  readonly breakdown: readonly MassEntry[];
}

export interface MassEntry {
  label: string;
  slot: string;
  massGrams: number;
}

export interface ElectricalSummary {
  /** Pack cells. */
  cells: number;
  /** Pack nominal voltage, V. */
  nominalVoltage: number;
  /** Pack internal resistance, Ω. */
  packResistanceOhm: number;
  capacityMah: number;
  /** ESC continuous current ceiling across all four motors, A. */
  escMaxAmps: number;
  /** Per-motor current ceiling, A. */
  motorCurrentLimitAmps: number;
  /** Estimated hover current per motor, A. */
  hoverAmpsPerMotor: number;
  /** Estimated hover speed per motor, RPM. */
  hoverRpmPerMotor: number;
  /** Estimated hover current for the whole build, A. */
  hoverAmpsTotal: number;
  /** Pack peak power available, W. */
  packPeakWatts: number;
  /** Thrust available per motor before the current ceiling, N. */
  maxThrustPerMotor: number;
  /** Thrust available per motor at the current ceiling, N. */
  limitedThrustPerMotor: number;
  /** Total max thrust / AUW. Under 1.5 you cannot climb on 6S. */
  thrustToWeight: number;
}

export interface AeroSummary {
  /** Frontal area facing forward, m². */
  frontalAreaM2: number;
  /** Side area, m² — roughly 5× frontal on a quad. */
  sideAreaM2: number;
  /** Top area, m². */
  topAreaM2: number;
  /** Equivalent drag coefficients. */
  cdFrontal: number;
  cdSide: number;
  cdTop: number;
  /** Reference area for the prop discs, m². */
  propDiscAreaM2: number;
  /** Prop disc diameter, m. */
  propDiameterM: number;
  /** Reference length for rotational damping, m. */
  bodyLengthM: number;
}

export interface VideoSummary {
  linkType: VideoLinkType;
  /** Frequency in Hz for the link budget. */
  frequencyHz: number;
  /** Combined TX + RX antenna gain, dBi. */
  gainDbi: number;
  latencyMs: number;
  cameraTvl: number;
  lensFovRad: number;
  hasIntegratedCamera: boolean;
  outputMilliwatts: number;
}

export interface ControlSummary {
  protocol: ControlProtocol;
  frequencyHz: number;
  txPowerDbm: number;
  sensitivityDbm: number;
  refreshRateHz: number;
  diversity: boolean;
}

/** Sensor width → horizontal field of view in radians for a given focal length. */
export function fieldOfView(focalLengthMm: number, sensorWidthInches: number): number {
  const sensorWidthMm = sensorWidthInches * 25.4;
  return 2 * Math.atan(sensorWidthMm / (2 * focalLengthMm));
}

const part = (spec: BuildSpec, slot: keyof BuildSpec['slots']): Part | null =>
  findPart(spec.slots[slot]);

const findOf = <T extends Part>(
  spec: BuildSpec,
  slot: keyof BuildSpec['slots'],
  category: T['category'],
): T | null => {
  const p = findPart(spec.slots[slot]);
  return p && p.category === category ? (p as T) : null;
};

export function resolveBuild(spec: BuildSpec): ResolvedBuild {
  const frame = findOf<FramePart>(spec, 'frame', 'frame');
  const motor = findOf<MotorPart>(spec, 'motor', 'motor');
  const propA = findOf<PropPart>(spec, 'propA', 'prop');
  const propB = findOf<PropPart>(spec, 'propB', 'prop');
  const battery = findOf<BatteryPart>(spec, 'battery1', 'battery');
  const vtx = part(spec, 'vtx');
  const camera = part(spec, 'camera');
  const lens = part(spec, 'lens');
  const rx = part(spec, 'rx');
  const antenna = part(spec, 'antenna');
  const gps = part(spec, 'gps');
  const stack = part(spec, 'stack');
  const fc = part(spec, 'fc');
  const esc = part(spec, 'esc');

  // --- Geometry --------------------------------------------------------
  const wheelbaseM = frame ? frame.motorToMotorMm / 1000 : 0.22;
  const a = wheelbaseM / (2 * Math.SQRT2);
  const motors: MotorPlacement[] = [
    { index: 0, name: 'rear-right', position: { x: a, y: 0, z: -a }, spin: MOTOR_SPIN[0] },
    { index: 1, name: 'front-right', position: { x: a, y: 0, z: a }, spin: MOTOR_SPIN[1] },
    { index: 2, name: 'rear-left', position: { x: -a, y: 0, z: -a }, spin: MOTOR_SPIN[2] },
    { index: 3, name: 'front-left', position: { x: -a, y: 0, z: a }, spin: MOTOR_SPIN[3] },
  ];

  const propModel = buildPropModel(
    propA ?? propB ?? FALLBACK_PROP,
  );
  const propMassKg = gramsToKg(((propA ?? propB)?.massGrams ?? 2.2) as number);

  // --- Mass distribution ----------------------------------------------
  const entries: MassEntry[] = [];
  const push = (label: string, slot: string, grams: number, at: Vec3) => {
    if (grams <= 0) return;
    entries.push({ label, slot, massGrams: grams });
    accumulate(gramsToKg(grams), at);
  };

  // First moment of mass, so the centre of gravity falls out of the layout.
  const massAccumulator = { x: 0, y: 0, z: 0 };
  let totalMass = 0;
  const accumulate = (kg: number, at: Vec3) => {
    totalMass += kg;
    massAccumulator.x += kg * at.x;
    massAccumulator.y += kg * at.y;
    massAccumulator.z += kg * at.z;
  };

  if (frame) push(`${frame.brand} ${frame.name}`, 'frame', frame.massGrams, { x: 0, y: 0, z: 0 });
  if (motor) {
    for (const m of motors) push(`${motor.brand} ${motor.name}`, `motor${m.index + 1}`, motor.massGrams, m.position);
  }
  if (propA) push(`${propA.brand} ${propA.name} (A)`, 'propA', propA.massGrams * 2, { x: 0, y: 0, z: 0 });
  if (propB && propB.id !== propA?.id) {
    push(`${propB.brand} ${propB.name} (B)`, 'propB', propB.massGrams * 2, { x: 0, y: 0, z: 0 });
  }
  for (const p of [stack, fc, esc]) if (p) push(`${p.brand} ${p.name}`, p.category, p.massGrams, LAYOUT.stack);
  if (vtx) push(`${vtx.brand} ${vtx.name}`, 'vtx', vtx.massGrams, LAYOUT.vtx);
  if (camera) push(`${camera.brand} ${camera.name}`, 'camera', camera.massGrams, LAYOUT.camera);
  if (lens) push(`${lens.brand} ${lens.name}`, 'lens', lens.massGrams, LAYOUT.lens);
  if (rx) push(`${rx.brand} ${rx.name}`, 'rx', rx.massGrams, LAYOUT.rx);
  if (antenna) push(`${antenna.brand} ${antenna.name}`, 'antenna', antenna.massGrams, LAYOUT.antenna);
  if (gps) push(`${gps.brand} ${gps.name}`, 'gps', gps.massGrams, LAYOUT.gps);

  // Wiring, heat shrink and straps are real mass on every build.
  const wiringGrams = 14 + (battery?.cells ?? 0) * 1.5;
  push('Wiring & hardware', 'misc', wiringGrams, { x: 0, y: 0, z: 0 });

  const batteryCount = battery ? (spec.slots.battery2 && frame && frame.batterySlots > 1 ? 2 : 1) : 0;
  if (battery && batteryCount > 0) {
    push(`${battery.brand} ${battery.name}`, 'battery1', battery.massGrams * batteryCount, LAYOUT.battery);
  }

  const auwKg = totalMass;
  const cg: Vec3 =
    totalMass > 0
      ? { x: massAccumulator.x / totalMass, y: massAccumulator.y / totalMass, z: massAccumulator.z / totalMass }
      : { x: 0, y: 0, z: 0 };

  // --- Inertia tensor (body frame) --------------------------------------
  const inertia = computeInertia(spec, frame, motor, cg, propMassKg, wheelbaseM);

  // --- Electrical ------------------------------------------------------
  const escMaxAmps =
    stack && 'maxContinuousAmps' in stack
      ? (stack.maxContinuousAmps as number)
      : esc && 'maxContinuousAmps' in esc
        ? (esc.maxContinuousAmps as number)
        : 60;
  const escInputMax = stack && 'inputVoltageMax' in stack ? (stack.inputVoltageMax as number) : 25.2;
  const motorCurrentLimit = motor?.maxCurrentAmps ?? 40;
  const currentLimitAmps = Math.min(motorCurrentLimit, escMaxAmps);

  const propDiameterM = inchToMeter((propA ?? propB)?.diameterInches ?? 5);
  const hoverThrustPerMotor = (auwKg * GRAVITY) / 4;
  // Inverse of the prop curve: n = sqrt(T / (Ct ρ D⁴)).
  const ct = propModel.ct;
  const hoverRpmPerSec = Math.sqrt(hoverThrustPerMotor / (ct * 1.225 * Math.pow(propDiameterM, 4)));
  // Torque balance: I = τ/Ke with τ = T·D / (2π · FoM).
  const ke = motor ? 60 / (2 * Math.PI * motor.kvRpmPerVolt) : 0.0055;
  const foM = propA?.figureOfMerit ?? 0.6;
  const hoverAmpsPerMotor = motor
    ? (hoverThrustPerMotor * propDiameterM) / (2 * Math.PI * foM * ke)
    : 0;

  // Max thrust is whichever binds first: the prop at the motor's no-load speed
  // on the highest safe voltage, or the ESC/motor current ceiling.
  const maxThrustUnlimited = motor
    ? ct * 1.225 * Math.pow((motor.kvRpmPerVolt * escInputMax) / 60, 2) * Math.pow(propDiameterM, 4)
    : 0;
  // At the current ceiling the motor can only make Ke·I worth of torque, and
  // torque converts to thrust at τ = T·D/(2π·FoM) → T = 2π·τ·FoM/D.
  const limitedThrust = motor
    ? (2 * Math.PI * ke * currentLimitAmps * foM) / propDiameterM
    : 0;

  const packResistanceOhm = (battery?.packResistanceMilliOhm ?? 7) / 1000;
  const capacityMah = (battery?.capacityMah ?? 1300) as number;
  const nominalVoltage = (battery?.nominalVoltage ?? 22.2) as number;

  const maxThrustPerMotor = Math.min(maxThrustUnlimited, limitedThrust);
  const electrical: ElectricalSummary = {
    cells: battery?.cells ?? 0,
    nominalVoltage,
    packResistanceOhm,
    capacityMah,
    escMaxAmps,
    motorCurrentLimitAmps: motorCurrentLimit,
    hoverAmpsPerMotor,
    hoverRpmPerMotor: hoverRpmPerSec * 60,
    hoverAmpsTotal: hoverAmpsPerMotor * 4,
    packPeakWatts: nominalVoltage * (battery?.burstDischargeAmps ?? 120),
    maxThrustPerMotor,
    limitedThrustPerMotor: limitedThrust,
    thrustToWeight: auwKg > 0 ? (maxThrustPerMotor * 4) / (auwKg * GRAVITY) : 0,
  };

  // --- Aerodynamics -----------------------------------------------------
  const rotorRadius = propDiameterM / 2;
  const armLength = frame
    ? frame.armThicknessMm / 1000 + rotorRadius
    : rotorRadius + 0.03;
  const frontalAreaM2 = Math.max(0.0035, 2 * armLength * (rotorRadius + 0.03));
  const aero: AeroSummary = {
    frontalAreaM2,
    sideAreaM2: frontalAreaM2 * 4.5,
    topAreaM2: Math.max(0.02, 4 * Math.PI * rotorRadius * rotorRadius * 0.85),
    cdFrontal: 0.85,
    cdSide: 0.9,
    cdTop: 1.1,
    propDiscAreaM2: propModel.discAreaM2,
    propDiameterM,
    bodyLengthM: wheelbaseM,
  };

  // --- Video / control summaries ---------------------------------------
  const vtxSpec = vtx && vtx.category === 'vtx' ? vtx : null;
  const cameraSpec = camera && camera.category === 'camera' ? camera : null;
  const lensSpec = lens && lens.category === 'lens' ? lens : null;
  const antennaSpec = antenna && antenna.category === 'antenna' ? antenna : null;
  const integrated = vtxSpec?.integratedCamera ?? null;
  const sensorInches = integrated?.sensorSizeInches ?? cameraSpec?.sensorSizeInches ?? 0.229;
  const focal = lensSpec?.focalLengthMm ?? 2.1;

  const video: VideoSummary = {
    linkType: vtxSpec?.linkType ?? 'analog',
    frequencyHz: (vtxSpec?.frequencyBandMhz ?? 5800) * 1e6,
    gainDbi: (antennaSpec?.gainDbi ?? 2) + 1.5, // +1.5 dBi for the pilot's goggle antennas
    latencyMs: (vtxSpec?.latencyMs ?? 2) + (cameraSpec?.latencyMs ?? 0),
    cameraTvl: integrated?.tvl ?? cameraSpec?.tvl ?? 600,
    lensFovRad: fieldOfView(focal, sensorInches),
    hasIntegratedCamera: integrated !== null,
    outputMilliwatts: vtxSpec?.outputMilliwatts ?? 25,
  };

  const rxSpec = rx && rx.category === 'rx' ? rx : null;
  const control: ControlSummary = {
    protocol: rxSpec?.protocol ?? 'expresslrs',
    frequencyHz: (rxSpec?.frequencyBandMhz ?? 2400) * 1e6,
    txPowerDbm: rxSpec?.txPowerDbm ?? 20,
    sensitivityDbm: rxSpec?.sensitivityDbm ?? -130,
    refreshRateHz: rxSpec?.refreshRateHz ?? 500,
    diversity: rxSpec?.diversity ?? false,
  };

  const totalPriceUsd = entries
    .map((e) => {
      const slotKey = e.slot.replace(/\d+$/, '') as keyof BuildSpec['slots'];
      return findPart(spec.slots[slotKey])?.priceUsd ?? 0;
    })
    .reduce((a, b) => a + b, 0);

  return {
    spec,
    auwKg,
    cg,
    inertia,
    wheelbaseM,
    armM: a,
    motors,
    propModel,
    propMassKg,
    motorInertiaKgM2: motor?.rotorInertiaKgM2 ?? 1.2e-5,
    frame,
    motor,
    battery,
    batteryCount,
    totalPriceUsd,
    electrical,
    aero,
    video,
    control,
    breakdown: entries,
  };
}

/**
 * Inertia tensor via the parallel axis theorem over every point mass, plus the
 * arms (treated as thin rods) and the spinning rotors.
 */
function computeInertia(
  spec: BuildSpec,
  frame: FramePart | null,
  motor: MotorPart | null,
  cg: Vec3,
  propMassKg: number,
  wheelbaseM: number,
): Mat3 {
  let izz = 0; // roll & pitch axes
  let iyy = 0; // yaw axis

  const add = (massKg: number, pos: Vec3) => {
    const dx = pos.x - cg.x;
    const dy = pos.y - cg.y;
    const dz = pos.z - cg.z;
    izz += massKg * (dy * dy + dz * dz);
    iyy += massKg * (dx * dx + dz * dz);
  };

  if (frame) {
    // Frame body mass sits roughly at the geometric centre; the arms are the
    // dominant rotational contribution and are modelled as four thin rods.
    add(gramsToKg(frame.massGrams) * 0.35, { x: 0, y: 0, z: 0 });
    const armMass = gramsToKg(frame.massGrams) * 0.65;
    const arm = wheelbaseM / 2;
    add(armMass * 0.25, { x: arm, y: 0, z: -arm });
    add(armMass * 0.25, { x: arm, y: 0, z: arm });
    add(armMass * 0.25, { x: -arm, y: 0, z: -arm });
    add(armMass * 0.25, { x: -arm, y: 0, z: arm });
  }
  if (motor) {
    const arm = wheelbaseM / 2;
    for (const [x, z] of [
      [arm, -arm],
      [arm, arm],
      [-arm, -arm],
      [-arm, arm],
    ]) {
      add(gramsToKg(motor.massGrams), { x, y: 0, z });
    }
  }
  const propMass = propMassKg * 4;
  add(propMass * 0.5, { x: 0, y: 0.02, z: -wheelbaseM / 4 });
  add(propMass * 0.5, { x: 0, y: 0.02, z: wheelbaseM / 4 });

  // Battery and electronics by name, matching the layout table.
  for (const slot of Object.keys(spec.slots) as (keyof BuildSpec['slots'])[]) {
    const p = findPart(spec.slots[slot]);
    if (!p) continue;
    const at =
      p.category === 'battery'
        ? LAYOUT.battery
        : p.category === 'vtx'
          ? LAYOUT.vtx
          : p.category === 'camera'
            ? LAYOUT.camera
            : p.category === 'lens'
              ? LAYOUT.lens
              : p.category === 'rx'
                ? LAYOUT.rx
                : p.category === 'antenna'
                  ? LAYOUT.antenna
                  : p.category === 'gps'
                    ? LAYOUT.gps
                    : p.category === 'stack' || p.category === 'fc' || p.category === 'esc'
                      ? LAYOUT.stack
                      : null;
    if (at) add(gramsToKg(p.massGrams), at);
  }

  // Rotors spinning in their planes add a small tangential-axis term.
  const rotor = motor ? motor.rotorInertiaKgM2 : 1.2e-5;
  const radius = wheelbaseM / (2 * Math.SQRT2);
  const rotorI = 4 * 0.5 * rotor * radius * radius;
  izz += rotorI;

  const floor = 1e-5;
  return [Math.max(izz, floor), 0, 0, 0, Math.max(iyy, floor), 0, 0, 0, Math.max(izz, floor)];
}

/** Placeholder so a build without props still resolves to something sane. */
const FALLBACK_PROP: PropPart = {
  id: 'prop-hq-r38',
  brand: 'HQProp',
  name: 'R38 5"×3.6×3',
  category: 'prop',
  massGrams: 2.2,
  priceUsd: 3.5,
  specSource: 'datasheet',
  diameterInches: 5.1,
  pitchInches: 3.6,
  bladeCount: 3,
  figureOfMerit: 0.6,
  hubDiameterInches: 1.6,
  profileDragScale: 1,
};
