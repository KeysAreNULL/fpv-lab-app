/**
 * Build compatibility rules. These produce builder warnings, not hard blocks —
 * a pilot can bolt anything to anything, and the sim should show them the
 * consequences (it will, via thrust, current draw and video/control behaviour).
 */

import { findPart, type Part, type PartSlot } from '../parts';
import type { BuildSpec } from '../parts/presets';
import type {
  AntennaPart,
  BatteryPart,
  CameraPart,
  EscPart,
  FcPart,
  FramePart,
  LensPart,
  MotorPart,
  PropPart,
  RxPart,
  StackPart,
  TxRadioPart,
  VtxPart,
} from '../parts/spec';

export type IssueLevel = 'error' | 'warning' | 'info';

export interface BuildIssue {
  level: IssueLevel;
  slot?: PartSlot;
  message: string;
}

const get = <T extends Part>(
  spec: BuildSpec,
  slot: PartSlot,
  narrow: (p: Part) => p is T,
): T | null => {
  const part = findPart(spec.slots[slot]);
  return part && narrow(part) ? part : null;
};

const isMotor = (p: Part): p is MotorPart => p.category === 'motor';
const isFrame = (p: Part): p is FramePart => p.category === 'frame';
const isProp = (p: Part): p is PropPart => p.category === 'prop';
const isBattery = (p: Part): p is BatteryPart => p.category === 'battery';
const isVtx = (p: Part): p is VtxPart => p.category === 'vtx';
const isCamera = (p: Part): p is CameraPart => p.category === 'camera';

export function validateBuild(spec: BuildSpec): BuildIssue[] {
  const issues: BuildIssue[] = [];
  const frame = get(spec, 'frame', isFrame);
  const motor = get(spec, 'motor', isMotor);
  const propA = get(spec, 'propA', isProp);
  const propB = get(spec, 'propB', isProp);
  const vtx = get(spec, 'vtx', isVtx);
  const camera = get(spec, 'camera', isCamera);
  const battery = get(spec, 'battery1', isBattery);
  const stack = get(spec, 'stack', (p): p is StackPart => p.category === 'stack');
  const fc = get(spec, 'fc', (p): p is FcPart => p.category === 'fc');
  const esc = get(spec, 'esc', (p): p is EscPart => p.category === 'esc');
  const rx = get(spec, 'rx', (p): p is RxPart => p.category === 'rx');
  const tx = get(spec, 'tx', (p): p is TxRadioPart => p.category === 'tx');
  const antenna = get(spec, 'antenna', (p): p is AntennaPart => p.category === 'antenna');
  const lens = get(spec, 'lens', (p): p is LensPart => p.category === 'lens');

  if (!frame) {
    issues.push({ level: 'error', slot: 'frame', message: 'No frame fitted — nothing else can be mounted.' });
    return issues;
  }

  // --- Motor fit -------------------------------------------------------
  if (!motor) {
    issues.push({ level: 'error', slot: 'motor', message: 'No motor fitted.' });
  } else {
    if (motor.mount !== frame.motorMount) {
      issues.push({
        level: 'error',
        slot: 'motor',
        message: `${motor.brand} ${motor.name} is ${motor.mount}; ${frame.brand} ${frame.name} takes ${frame.motorMount}.`,
      });
    }
    const armLoad = motor.maxThrustGrams;
    if (armLoad > frame.maxMotorThrustGrams) {
      issues.push({
        level: 'warning',
        slot: 'motor',
        message: `Motor can produce ${armLoad} g against an arm budget of ${frame.maxMotorThrustGrams} g — arms may bend.`,
      });
    }
  }

  // --- Flight controller / ESC ----------------------------------------
  if (stack && (fc || esc)) {
    issues.push({
      level: 'error',
      slot: 'stack',
      message: 'Fitted both an AIO stack and separate FC/ESC. Pick one.',
    });
  }
  if (stack) {
    if (stack.mount !== frame.stackMount) {
      issues.push({
        level: 'error',
        slot: 'stack',
        message: `Stack mounts ${stack.mount}; frame takes ${frame.stackMount}.`,
      });
    }
    if (stack.motorMount !== frame.motorMount) {
      issues.push({
        level: 'warning',
        slot: 'stack',
        message: `Stack ESC pads are ${stack.motorMount}; frame motor pattern is ${frame.motorMount}.`,
      });
    }
  }
  for (const [slot, part] of [
    ['fc', fc],
    ['esc', esc],
  ] as const) {
    if (part && part.mount !== frame.stackMount) {
      issues.push({
        level: 'error',
        slot,
        message: `${part.brand} ${part.name} mounts ${part.mount}; frame takes ${frame.stackMount}.`,
      });
    }
  }
  if (!stack && !fc && !esc) {
    issues.push({ level: 'error', slot: 'stack', message: 'No flight controller or ESC fitted.' });
  }

  // --- Video -----------------------------------------------------------
  if (!vtx) {
    issues.push({ level: 'warning', slot: 'vtx', message: 'No VTX fitted — you will be flying blind.' });
  } else {
    if (vtx.linkType === 'digital') {
      if (camera) {
        issues.push({
          level: 'error',
          slot: 'camera',
          message: `${vtx.brand} ${vtx.name} has an integrated digital camera — remove the analog camera.`,
        });
      }
    } else {
      if (!camera) {
        issues.push({
          level: 'error',
          slot: 'camera',
          message: `${vtx.brand} ${vtx.name} is analog and needs a separate camera.`,
        });
      } else if (camera.linkType !== 'analog') {
        issues.push({ level: 'error', slot: 'camera', message: 'Analog VTX needs an analog camera.' });
      } else if (camera.widthMm > frame.cameraWidthMm) {
        issues.push({
          level: 'error',
          slot: 'camera',
          message: `Camera is ${camera.widthMm} mm wide; frame side plate fits ${frame.cameraWidthMm} mm.`,
        });
      }
      if (lens) {
        const cam = get(spec, 'camera', isCamera);
        if (cam && cam.lensMount !== lens.mount) {
          issues.push({
            level: 'warning',
            slot: 'lens',
            message: `Lens is ${lens.mount}; camera takes ${cam.lensMount}.`,
          });
        }
      } else {
        issues.push({ level: 'warning', slot: 'lens', message: 'No lens fitted — the camera has no glass.' });
      }
    }
  }

  // --- Control link ----------------------------------------------------
  if (!rx) {
    issues.push({ level: 'error', slot: 'rx', message: 'No receiver fitted.' });
  }
  if (rx && tx) {
    if (rx.protocol !== tx.protocol) {
      issues.push({
        level: 'error',
        slot: 'tx',
        message: `${tx.brand} ${tx.name} speaks ${tx.protocol}; ${rx.brand} ${rx.name} speaks ${rx.protocol}.`,
      });
    }
    if (rx.frequencyBandMhz !== tx.frequencyBandMhz) {
      issues.push({
        level: 'warning',
        slot: 'tx',
        message: `TX on ${tx.frequencyBandMhz} MHz, RX on ${rx.frequencyBandMhz} MHz — these cannot bind.`,
      });
    }
  }
  const fcOrStack = stack ?? fc;
  if (rx && fcOrStack && !fcOrStack.protocols.includes(rx.protocol)) {
    issues.push({
      level: 'warning',
      slot: 'rx',
      message: `Flight controller does not list ${rx.protocol} support.`,
    });
  }

  // --- Antenna ---------------------------------------------------------
  if (vtx && antenna) {
    const vtxBand = vtx.frequencyBandMhz === 5800 ? 5800 : vtx.frequencyBandMhz;
    if (antenna.bandMhz !== vtxBand) {
      issues.push({
        level: 'error',
        slot: 'antenna',
        message: `Antenna is ${antenna.bandMhz} MHz; VTX transmits on ${vtxBand} MHz.`,
      });
    }
  }

  // --- Props -----------------------------------------------------------
  for (const [slot, prop] of [
    ['propA', propA],
    ['propB', propB],
  ] as const) {
    if (prop) {
      const delta = Math.abs(prop.diameterInches - frame.propSizeInches);
      if (delta > 0.3) {
        issues.push({
          level: 'warning',
          slot,
          message: `${prop.diameterInches}" prop on a ${frame.propSizeInches}" frame — it will foul or undershoot.`,
        });
      }
    }
  }
  if (propA && propB && propA.id !== propB.id) {
    issues.push({
      level: 'info',
      slot: 'propB',
      message: 'Mixed prop sets change yaw authority and trim — a deliberate freestyle/race choice.',
    });
  }

  // --- Battery ---------------------------------------------------------
  if (!battery) {
    issues.push({ level: 'error', slot: 'battery1', message: 'No battery fitted — the build cannot arm.' });
  } else {
    const maxCells = maxCellsForFrame(frame);
    if (battery.cells > maxCells) {
      issues.push({
        level: 'error',
        slot: 'battery1',
        message: `${battery.cells}S pack but ${frame.brand} ${frame.name} only takes ${maxCells}S.`,
      });
    }
    if (frame.batterySlots === 1 && spec.slots.battery2) {
      issues.push({
        level: 'warning',
        slot: 'battery2',
        message: `${frame.brand} ${frame.name} has a single battery slot — the second pack is not carried.`,
      });
    }
    const escLimit = stack?.inputVoltageMax ?? esc?.inputVoltageMax;
    if (escLimit && battery.maxVoltage > escLimit) {
      issues.push({
        level: 'error',
        slot: 'battery1',
        message: `Pack peaks at ${battery.maxVoltage} V; ESC is rated to ${escLimit} V.`,
      });
    }
    if (vtx && battery.maxVoltage < vtx.inputVoltageMin) {
      issues.push({
        level: 'warning',
        slot: 'battery1',
        message: `${vtx.brand} ${vtx.name} needs at least ${vtx.inputVoltageMin} V.`,
      });
    }
    if (motor && kvAdvice(motor, battery.cells)) {
      issues.push({ level: 'info', slot: 'battery1', message: kvAdvice(motor, battery.cells)! });
    }
  }

  return issues;
}

/** Practical cell count ceiling per frame class. */
export function maxCellsForFrame(frame: FramePart): number {
  switch (frame.frameClass) {
    case 'whoop':
      return 4;
    case 'cinewhoop':
      return 6;
    case 'inch5':
      return 8;
    case 'inch7':
      return 8;
  }
}

/**
 * The KV rule of thumb: (Kv · cells) / 1000 should land in 4–7 for a clean
 * operating point. Informational only — the sim never enforces it.
 */
function kvAdvice(motor: MotorPart, cells: number): string | null {
  const figure = (motor.kvRpmPerVolt * cells) / 1000;
  if (figure < 3.4) {
    return `Kv×S is ${figure.toFixed(1)} — undergeared, expect slow throttle response and poor efficiency.`;
  }
  if (figure > 7.6) {
    return `Kv×S is ${figure.toFixed(1)} — overgeared, expect high current draw, heat and short pack life.`;
  }
  return null;
}

/** True when the build has everything needed to arm. */
export function canArm(spec: BuildSpec): boolean {
  return !validateBuild(spec).some((i) => i.level === 'error');
}

export type { BuildSpec };
