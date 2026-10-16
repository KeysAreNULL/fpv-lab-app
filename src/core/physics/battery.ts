/**
 * LiPo cell model: open-circuit voltage vs state of charge, internal resistance
 * that rises as the pack empties and cools, thermal mass from I²R, Coulomb
 * counting for capacity, and sag/recovery that the rest of the sim feels.
 *
 * The pack is the feedback loop that makes FPV flight feel real: motors draw
 * current, current drops the terminal voltage, low voltage means lower motor
 * speed, which means less thrust — and a sagging pack sags more under load the
 * emptier it gets.
 */

import { clamp } from '../math/vec3';
import type { BatteryPart } from '../parts/spec';

/** Open-circuit voltage per cell at 100% charge for a modern LiPo. */
const OCV_FULL = 4.2;
/** Open-circuit voltage per cell at 0% charge (storage). */
const OCV_EMPTY = 3.55;
/** Nominal cell voltage. */
const OCV_NOMINAL = 3.7;
/** Cell voltage below which a LiPo is considered over-discharged. */
const CUTOFF_VOLTAGE = 3.0;

/**
 * Fractional state of charge → open-circuit cell voltage.
 *
 * LiPo discharge is famously flat: the curve holds near nominal down to ~40%
 * charge, then drops off a cliff. A linear map badly misrepresents both the
 * available energy and the sag behaviour near empty, so this uses a two-piece
 * curve with a knee at 40%.
 */
export function openCircuitVoltage(soc: number): number {
  const s = clamp(soc, 0, 1);
  if (s >= 0.4) {
    // Flat region: 3.70 V at 40% rising to 4.20 V at 100%.
    const t = (s - 0.4) / 0.6;
    return OCV_NOMINAL + (OCV_FULL - OCV_NOMINAL) * t;
  }
  // Steep region: 4.20 V down to 3.55 V with a slight convexity.
  const t = s / 0.4;
  return OCV_EMPTY + (OCV_FULL - OCV_EMPTY) * Math.pow(t, 0.72);
}

export interface BatteryState {
  /** State of charge, 0..1. */
  soc: number;
  /** Pack terminal voltage, V — this is the sagging voltage, not OCV. */
  voltage: number;
  /** Current drawn by the build, A. Positive = discharging. */
  currentAmps: number;
  /** Instantaneous power delivered, W. */
  powerWatts: number;
  /** Internal temperature, °C. */
  temperatureC: number;
  /** Cell voltage under load, V (use this for brownout warnings). */
  cellVoltage: number;
  /** Cumulative charge used this session, Ah. */
  chargeUsedAh: number;
  /** True once a cell drops below the cutoff under load. */
  brownout: boolean;
  /** 0..1 pack health: permanent capacity loss from over-discharge / heat. */
  health: number;
}

export interface BatteryLimits {
  /** Pack internal resistance at reference conditions, Ω. */
  packResistanceOhm: number;
  /** Cell count. */
  cells: number;
  /** Capacity in amp-hours. */
  capacityAh: number;
  /** Hard current ceiling (c-rating × capacity), A. */
  maxAmps: number;
  /** Minimum cell voltage before the pack is considered flat, V. */
  cutoffVoltage: number;
  /** Ambient temperature, °C. */
  ambientC: number;
}

export class Battery {
  readonly limits: BatteryLimits;
  readonly state: BatteryState;

  constructor(part: BatteryPart, ambientC = 20) {
    this.limits = {
      packResistanceOhm: part.packResistanceMilliOhm / 1000,
      cells: part.cells,
      capacityAh: part.capacityMah / 1000,
      maxAmps: Math.max(part.burstDischargeAmps, 1),
      cutoffVoltage: part.minVoltagePerCell,
      ambientC,
    };
    // A pack that has been flown is not at 4.2 V/cell. Start at 3.85 V/cell.
    const soc = (3.85 - OCV_EMPTY) / (OCV_FULL - OCV_EMPTY);
    const startSoc = clamp(soc, 0.05, 1);
    this.state = {
      soc: startSoc,
      voltage: openCircuitVoltage(startSoc) * part.cells,
      currentAmps: 0,
      powerWatts: 0,
      temperatureC: ambientC,
      cellVoltage: 3.85,
      chargeUsedAh: 0,
      brownout: false,
      health: 1,
    };
  }

  /** Reset charge to full for a fresh pack. */
  recharge(): void {
    this.state.soc = 1;
    this.state.chargeUsedAh = 0;
    this.state.health = 1;
    this.state.brownout = false;
    this.state.temperatureC = this.limits.ambientC;
    this.state.voltage = openCircuitVoltage(1) * this.limits.cells;
    this.state.cellVoltage = openCircuitVoltage(1);
    this.state.currentAmps = 0;
    this.state.powerWatts = 0;
  }

  /**
   * Internal resistance as a function of state of charge and temperature.
   *
   * LiPo packs get *more* resistive when cold and when low on charge — both
   * effects are why a half-drained pack on a winter morning browns out under a
   * punchout, and why warm packs outperform cold ones at the same capacity.
   */
  private internalResistance(): number {
    const { soc, temperatureC } = this.state;
    // +55% resistance at empty, +12% at full (a soft knee rather than a cliff).
    const socFactor = 1 + 0.55 * Math.pow(1 - clamp(soc, 0, 1), 2.2);
    // Cold packs are the dominant real-world factor: ~1%/°C below 25 °C.
    const tempFactor = 1 + 0.01 * Math.max(0, 25 - temperatureC);
    return this.limits.packResistanceOhm * socFactor * tempFactor;
  }

  /**
   * Advance one substep.
   *
   * `requestedAmps` is the TOTAL current the pack is delivering, in series
   * through all cells. That distinction matters:
   *
   *   - Terminal sag is I_total × R_pack. A 100 A punchout on a 6.5 mΩ 6S pack
   *     drops the whole pack 0.65 V.
   *   - Capacity drain is per cell: each cell only supplies I_total / cells.
   *
   * The feedback loop — current drops the voltage, low voltage lowers motor
   * speed, which lowers the current demand — is resolved in
   * `physics/quadrotor.ts`, which steps this model and the motors together. All
   * this model has to do is integrate Coulomb counting and heat.
   */
  step(requestedAmps: number, dt: number): BatteryState {
    const s = this.state;
    const ocv = openCircuitVoltage(s.soc) * this.limits.cells;
    const r = this.internalResistance();

    const amps = Math.max(0, requestedAmps);
    const voltage = Math.max(0, ocv - amps * r);

    s.currentAmps = amps;
    s.voltage = voltage;
    s.cellVoltage = voltage / this.limits.cells;
    s.powerWatts = voltage * amps;

    // Coulomb counting: dSoC = -I·dt / (3600·Q), with I the per-cell current.
    const perCellAmps = amps / this.limits.cells;
    const usableAh = this.limits.capacityAh * s.health;
    s.soc = clamp(s.soc - perCellAmps * dt / (3600 * Math.max(usableAh, 1e-4)), 0, 1);
    s.chargeUsedAh += (perCellAmps * dt) / 3600;

    // I²R heating with a first-order thermal lag towards ambient.
    const joules = amps * amps * r * dt;
    const heatCapacity = 46; // J/°C for a 6-cell 18650 pack in a shrink wrap
    const cooling = (s.temperatureC - this.limits.ambientC) * 1.35;
    s.temperatureC += (joules / heatCapacity - cooling * dt) / Math.max(1, dt);
    s.temperatureC = clamp(s.temperatureC, -30, 120);

    s.brownout = s.cellVoltage < this.limits.cutoffVoltage;

    // Permanent damage: over-discharge or sustained heat degrades capacity.
    if (s.soc <= 0.0001 && perCellAmps > 0.2) s.health = clamp(s.health - dt * 0.002, 0.4, 1);
    if (s.temperatureC > 75) s.health = clamp(s.health - dt * 0.0004, 0.4, 1);

    return s;
  }

  /** Terminal voltage if `amps` were drawn right now, without stepping. */
  voltageUnderLoad(amps: number): number {
    return Math.max(0, openCircuitVoltage(this.state.soc) * this.limits.cells - amps * this.internalResistance());
  }

  /** Estimated remaining flight time at the current draw, seconds. */
  remainingSeconds(currentAmps: number): number {
    if (currentAmps <= 0.1) return Number.POSITIVE_INFINITY;
    return (this.state.soc * this.limits.capacityAh * this.state.health * 3600) / currentAmps;
  }

  /** Max continuous pack output at the current state, W — the "is this enough" number. */
  maxDischargeWatts(): number {
    return this.voltageUnderLoad(this.limits.maxAmps) * this.limits.maxAmps;
  }
}

export const CELL_VOLTAGE_LIMITS = {
  full: OCV_FULL,
  nominal: OCV_NOMINAL,
  empty: OCV_EMPTY,
  cutoff: CUTOFF_VOLTAGE,
} as const;
