/**
 * RF link model for both the control link and the video downlink.
 *
 * The link budget is a real one:
 *
 *   Rx power (dBm) = Tx power + Tx gain + Rx gain − FSPL − penetration loss
 *   FSPL (dB)      = 20·log₁₀(d) + 20·log₁₀(f) + 32.44      [d metres, f Hz]
 *
 * On top of that:
 *
 *  - Fresnel zone clearance. An obstacle inside the first Fresnel zone attenuates
 *    the link far more than the same obstacle outside it. This is why a hillside
 *    directly behind the pilot blocks the link but the same hillside 200 m to the
 *    side does not, and it is the single biggest missing feature in most sims.
 *  - Penetration loss per material. Concrete rebar is brutal at 5.8 GHz; drywall
 *    is nearly transparent. Each obstacle the link passes through contributes its
 *    own loss.
 *  - Multipath fading. Urban and indoor flying produces Rayleigh-ish fading whose
 *    depth depends on how much structure is around. A non-diversity RX (every
 *    ELRS 2.4 GHz RX is non-diversity) has no way to fight it.
 *
 * Analog and digital video then diverge sharply, which is the actual reason to
 * choose one over the other:
 *  - Analog degrades gradually into snow and then a rolling, tearing image.
 *  - Digital holds a clean picture until the link budget runs out, then drops
 *    frames, then cuts to black. No in-between. Much lower latency, no graceful
 *    degradation.
 */

import { FSPL_CONST, SPEED_OF_SOUND } from '../constants';
import { clamp, smoothstep, type Vec3 } from '../math/vec3';
import { createRng, type Rng } from '../math/rng';
import { fbm1 } from '../math/noise';
import type { ControlSummary, VideoSummary } from '../build/resolve';

/** Attenuation through one obstacle, by material. dB per metre of thickness. */
export interface Material {
  id: string;
  name: string;
  /** dB lost per metre of material. */
  dbPerMeter: number;
  /** 0..1 — how much RF energy scatters rather than absorbing. Drives multipath. */
  scattering: number;
  /** Effective thickness used when the ray passes near-edge-on, metres. */
  defaultThickness: number;
}

export const MATERIALS: Record<string, Material> = {
  concrete: { id: 'concrete', name: 'Reinforced Concrete', dbPerMeter: 22, scattering: 0.35, defaultThickness: 0.3 },
  brick: { id: 'brick', name: 'Brick', dbPerMeter: 14, scattering: 0.3, defaultThickness: 0.25 },
  wood: { id: 'wood', name: 'Wood / Timber', dbPerMeter: 5, scattering: 0.2, defaultThickness: 0.15 },
  drywall: { id: 'drywall', name: 'Drywall / Plasterboard', dbPerMeter: 3, scattering: 0.15, defaultThickness: 0.13 },
  glass: { id: 'glass', name: 'Glass Window', dbPerMeter: 2, scattering: 0.45, defaultThickness: 0.01 },
  metal: { id: 'metal', name: 'Sheet Metal / Fence', dbPerMeter: 35, scattering: 0.6, defaultThickness: 0.02 },
  foliage: { id: 'foliage', name: 'Tree Foliage', dbPerMeter: 9, scattering: 0.8, defaultThickness: 6 },
  earth: { id: 'earth', name: 'Earth / Rock', dbPerMeter: 12, scattering: 0.25, defaultThickness: 4 },
  plastic: { id: 'plastic', name: 'Plastic / Carbon', dbPerMeter: 2, scattering: 0.2, defaultThickness: 0.05 },
};

/** A line segment the RF ray is tested against. */
export interface Obstruction {
  start: Vec3;
  end: Vec3;
  materialId: string;
  /** Effective thickness perpendicular to the ray, metres. */
  thickness: number;
}

export interface LinkBudget {
  /** Distance between pilot and drone, metres. */
  distanceM: number;
  /** Free-space path loss, dB. */
  pathLossDb: number;
  /** Total loss through obstructions, dB. */
  penetrationLossDb: number;
  /** Fresnel zone clearance penalty, dB. */
  fresnelLossDb: number;
  /** Received power at the drone, dBm. */
  rxPowerDbm: number;
  /** Link margin over the receiver's sensitivity, dB. Negative = weak. */
  marginDb: number;
  /** 0..1 quality derived from the margin. */
  quality: number;
}

export type ControlLinkState = 'strong' | 'ok' | 'weak' | 'critical' | 'failsafe';
export type VideoLinkState = 'clean' | 'degraded' | 'snow' | 'lost';

export interface SignalSnapshot {
  control: {
    rssiDbm: number;
    /** ExpressLRS-style link quality, 0..100. */
    lq: number;
    state: ControlLinkState;
    budget: LinkBudget;
    /** Multipath fading term, dB. Negative = constructive. */
    fadingDb: number;
  };
  video: {
    rssiDbm: number;
    /** 0..1. 1 = perfect image. */
    quality: number;
    state: VideoLinkState;
    budget: LinkBudget;
    /** Estimated displayed latency, ms. */
    latencyMs: number;
    /** Static/snow amount for the analog path, 0..1. */
    snow: number;
    /** Frame drop rate for the digital path, 0..1. */
    droppedFrames: number;
  };
  /** Combined worst case, for the HUD warning light. */
  worst: 'control' | 'video' | 'none';
}

const TX_ANTENNA_GAIN_DB = 2;
const RX_ANTENNA_GAIN_DB = 2;

/** Free-space path loss in dB. */
export function freeSpacePathLoss(distanceM: number, frequencyHz: number): number {
  const d = Math.max(distanceM, 1);
  return 20 * Math.log10(d) + 20 * Math.log10(frequencyHz) + FSPL_CONST;
}

/** First Fresnel zone radius at the obstruction, metres. */
export function fresnelRadius(distance1: number, distance2: number, frequencyHz: number): number {
  const wavelength = SPEED_OF_SOUND / frequencyHz;
  return Math.sqrt((Math.max(distance1, 0.01) * Math.max(distance2, 0.01) * wavelength) / 2);
}

/**
 * Closest approach of a point to the line segment, plus where along it.
 * Returns null when there is no intersection within the segment.
 */
function segmentDistance(
  point: Vec3,
  a: Vec3,
  b: Vec3,
): { distance: number; t: number } | null {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq < 1e-9) return null;
  const t = clamp(
    ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / lenSq,
    0,
    1,
  );
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  const cz = a.z + abz * t;
  return { distance: Math.hypot(point.x - cx, point.y - cy, point.z - cz), t };
}

/** Perpendicular distance from the ray to an obstruction segment. */
function rayObstructionDistance(
  from: Vec3,
  to: Vec3,
  obstruction: Obstruction,
): number | null {
  // Sample the ray where it is closest to the obstruction's midpoint.
  const mid: Vec3 = {
    x: (obstruction.start.x + obstruction.end.x) / 2,
    y: (obstruction.start.y + obstruction.end.y) / 2,
    z: (obstruction.start.z + obstruction.end.z) / 2,
  };
  const hit = segmentDistance(mid, from, to);
  return hit ? hit.distance : null;
}

export interface SignalInputs {
  /** Pilot position (where they are standing with the transmitter), metres. */
  pilotPosition: Vec3;
  /** Antenna position on the drone, metres. */
  dronePosition: Vec3;
  control: ControlSummary;
  video: VideoSummary;
  /** Obstructions between the two. */
  obstructions: readonly Obstruction[];
  /** Elevation of terrain between them — adds earth penetration loss. */
  terrainClearance: number;
  time: number;
  /** Rain rate, mm/h. Adds a small, frequency-dependent loss. */
  rainMmPerHour: number;
  /** Extra multiplier on every loss — from prop damage or a dirty antenna. */
  damageFactor: number;
}

/**
 * Compute the full link budget for one path at a given frequency.
 * Shared by the control and video links; the only difference is the hardware.
 */
export function linkBudget(
  from: Vec3,
  to: Vec3,
  frequencyHz: number,
  txPowerDbm: number,
  gainDbi: number,
  sensitivityDbm: number,
  obstructions: readonly Obstruction[],
  extras: { rainMmPerHour: number; damageFactor: number; terrainClearance: number },
  rng: Rng,
): LinkBudget {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distanceM = Math.max(Math.hypot(dx, dy, dz), 0.5);
  const pathLossDb = freeSpacePathLoss(distanceM, frequencyHz);

  let penetrationLossDb = 0;
  let fresnelLossDb = 0;
  let scatterEnergy = 0;

  for (const obstruction of obstructions) {
    const hit = rayObstructionDistance(from, to, obstruction);
    if (hit === null) continue;
    const material = MATERIALS[obstruction.materialId] ?? MATERIALS.wood;
    // Only count it if the ray actually passes within the obstruction's extent.
    const halfExtent = Math.max(obstruction.thickness, material.defaultThickness) + 1.5;
    if (hit > halfExtent) continue;

    const distance1 = distanceM * (hit / Math.max(1, halfExtent));
    const distance2 = distanceM - distance1;
    const fresnel = fresnelRadius(distance1, distance2, frequencyHz);

    // Thin-shell attenuation: enter and exit.
    penetrationLossDb += material.dbPerMeter * obstruction.thickness * 2;

    if (hit < fresnel) {
      // Inside the first Fresnel zone: knife-edge diffraction gives roughly
      // 6 dB at the zone edge rising to ~20 dB deep inside it.
      const v = fresnel - hit;
      const diffractionLossDb = 6 + 14 * Math.pow(v / Math.max(fresnel, 0.01), 2);
      fresnelLossDb += diffractionLossDb;
    }

    scatterEnergy += material.scattering * clamp(1 - hit / halfExtent, 0, 1);
  }

  // Terrain obstruction is always thick earth.
  if (extras.terrainClearance < 0) {
    penetrationLossDb += MATERIALS.earth.dbPerMeter * Math.abs(extras.terrainClearance) * 0.6;
  }

  // Rain: specific attenuation, higher at higher frequency. ~0.1 dB/km at 5.8 GHz
  // in light rain, ~1 dB/km in heavy rain — small, but it adds up at range.
  const rainLossDb = extras.rainMmPerHour * 0.0002 * (frequencyHz / 1e9) * distanceM;

  const damagePenaltyDb = extras.damageFactor > 1 ? 20 * Math.log10(extras.damageFactor) : 0;

  const totalLoss =
    pathLossDb + penetrationLossDb + fresnelLossDb + rainLossDb + damagePenaltyDb;
  const rxPowerDbm = txPowerDbm + gainDbi + TX_ANTENNA_GAIN_DB + RX_ANTENNA_GAIN_DB - totalLoss;
  const marginDb = rxPowerDbm - sensitivityDbm;

  // Multpath: scattered energy means a deeper fade distribution.
  const fadeDepthDb = scatterEnergy * 18;
  const fadeDb = (rng.next() * 2 - 1) * fadeDepthDb * (0.5 + 0.5 * rng.next());
  const effectiveMargin = marginDb + fadeDb;

  // Quality rises steeply once you have margin, then saturates.
  const quality = clamp(smoothstep(-18, 6, effectiveMargin), 0, 1);

  void rng;
  return {
    distanceM,
    pathLossDb,
    penetrationLossDb,
    fresnelLossDb,
    rxPowerDbm: rxPowerDbm + fadeDb,
    marginDb: effectiveMargin,
    quality,
  };
}

/** Tracks the RF environment and produces per-tick signal snapshots. */
export class SignalModel {
  private readonly rng: Rng;
  private time = 0;
  private lastBudget: LinkBudget | null = null;
  /** Obstructions uploaded by the terrain generator for the current pilot spot. */
  obstructions: Obstruction[] = [];
  /** Terrain ray obstruction, negative = below the ray, metres. */
  terrainClearance = 0;

  constructor(seed: number) {
    this.rng = createRng(seed ^ 0x5f3a);
  }

  private smoothFading(time: number): number {
    // Two-scale fbm stands in for a walking-tx / rotating-drone fade envelope.
    return fbm1(time * 0.6, 3, 17) * 0.6 + fbm1(time * 2.7, 4, 91) * 0.4;
  }

  evaluate(inputs: Omit<SignalInputs, 'time'>, dt: number): SignalSnapshot {
    this.time += dt;
    const t = this.time;

    const controlBudget = linkBudget(
      inputs.pilotPosition,
      inputs.dronePosition,
      inputs.control.frequencyHz,
      inputs.control.txPowerDbm,
      0,
      inputs.control.sensitivityDbm,
      this.obstructions,
      {
        rainMmPerHour: inputs.rainMmPerHour,
        damageFactor: inputs.damageFactor,
        terrainClearance: this.terrainClearance,
      },
      this.rng,
    );

    const videoBudget = linkBudget(
      inputs.pilotPosition,
      inputs.dronePosition,
      inputs.video.frequencyHz,
      videoTxPowerDbm(inputs.video.outputMilliwatts),
      inputs.video.gainDbi,
      videoSensitivityDbm(inputs.video.linkType),
      this.obstructions,
      {
        rainMmPerHour: inputs.rainMmPerHour,
        damageFactor: inputs.damageFactor,
        terrainClearance: this.terrainClearance,
      },
      this.rng,
    );

    const fade = this.smoothFading(t);
    // ExpressLRS LQ maps roughly -105 dBm → 0 and -60 dBm → 100.
    const rssiDbm = clamp(controlBudget.rxPowerDbm + fade * 4, -120, -30);
    const lq = clamp(((rssiDbm + 115) / 55) * 100, 0, 100);
    const controlState = classifyControl(lq, inputs.control.sensitivityDbm, controlBudget.marginDb);

    const videoMargin = videoBudget.marginDb + fade * 5;
    const videoQuality = clamp(smoothstep(-20, 4, videoMargin), 0, 1);
    const video = this.classifyVideo(videoQuality, videoMargin, inputs.video, inputs.damageFactor);

    this.lastBudget = controlBudget;

    return {
      control: {
        rssiDbm,
        lq,
        state: controlState,
        budget: controlBudget,
        fadingDb: fade * 4,
      },
      video: {
        rssiDbm: videoBudget.rxPowerDbm + fade * 5,
        quality: videoQuality,
        state: video.state,
        budget: videoBudget,
        latencyMs: inputs.video.latencyMs,
        snow: video.snow,
        droppedFrames: video.droppedFrames,
      },
      worst: controlState === 'failsafe' ? 'control' : video.state === 'lost' ? 'video' : 'none',
    };
  }

  /**
   * Analog and digital diverge here, and this is the heart of the video model.
   *
   * Analog: snow rises smoothly with the shortfall, then the image tears and
   * rolls. The noise floor is visible long before the picture is unusable.
   * Digital: below ~0.85 quality the encoder starts dropping frames (because it
   * is spending packets on retransmits of a broken link), and at zero it cuts
   * straight to black. There is no snow.
   */
  private classifyVideo(
    quality: number,
    marginDb: number,
    video: VideoSummary,
    damageFactor: number,
  ): { state: VideoLinkState; snow: number; droppedFrames: number } {
    const shortfall = clamp(-marginDb / 25, 0, 1.2);

    if (video.linkType === 'digital') {
      if (marginDb < -28) return { state: 'lost', snow: 0, droppedFrames: 1 };
      const droppedFrames = clamp(smoothstep(4, -22, marginDb), 0, 0.95);
      if (marginDb < -8) return { state: 'degraded', snow: 0, droppedFrames };
      return { state: 'clean', snow: 0, droppedFrames };
    }

    // Analog: noise creeps in well before the picture fails.
    const noiseFloor = clamp(shortfall * 1.15 + (damageFactor - 1) * 0.3, 0, 1);
    const snow = clamp(noiseFloor * (1.2 - quality * 0.3), 0, 1);
    if (marginDb < -26) return { state: 'lost', snow: 1, droppedFrames: 0 };
    if (marginDb < -8) return { state: 'snow', snow, droppedFrames: 0 };
    if (marginDb < 4) return { state: 'degraded', snow, droppedFrames: 0 };
    return { state: 'clean', snow, droppedFrames: 0 };
  }

  get budget(): LinkBudget | null {
    return this.lastBudget;
  }
}

function classifyControl(lq: number, sensitivityDbm: number, marginDb: number): ControlLinkState {
  // ExpressLRS failsafes at 100 → 80 → then flight mode at <80, then stage 2.
  if (marginDb < -30) return 'failsafe';
  if (lq < 25) return 'critical';
  if (lq < 55) return 'weak';
  if (lq < 85) return 'ok';
  void sensitivityDbm;
  return 'strong';
}

/** Convert VTX output power in mW to dBm. */
export function videoTxPowerDbm(milliwatts: number): number {
  return 10 * Math.log10(Math.max(milliwatts, 0.1));
}

/**
 * Receiver sensitivity. Analog diversity/basic receivers are far less sensitive
 * than a well-designed digital one, which is exactly why analog keeps working at
 * distance on low power while digital punches through walls better.
 */
export function videoSensitivityDbm(linkType: 'analog' | 'digital'): number {
  return linkType === 'analog' ? -105 : -100;
}
