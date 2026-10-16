/**
 * Physical constants and unit conversions. Single source of truth — nothing
 * else in the codebase is allowed to hardcode 9.81 or 0.607.
 */

/** Standard gravity, m/s². */
export const GRAVITY = 9.80665;

/** ISA sea-level air density, kg/m³. Models scale it by pressure/temperature. */
export const AIR_DENSITY_SEA_LEVEL = 1.225;

/** Specific gas constant for dry air, J/(kg·K). */
export const R_SPECIFIC_AIR = 287.058;

/** Speed of sound at 15 °C, m/s. */
export const SPEED_OF_SOUND = 340.3;

/**
 * Free-space path loss constant, for the SI form
 *
 *   path loss (dB) = 20·log₁₀(d_m) + 20·log₁₀(f_Hz) + FSPL_CONST
 *
 * The textbook form `32.44 + 20·log₁₀(d_km) + 20·log₁₀(f_MHz)` converts to this
 * by subtracting 60 dB for km→m and 120 dB for MHz→Hz. Sanity check: 1 km at
 * 5.8 GHz gives 20·3 + 20·9.7634 − 147.55 = 107.7 dB.
 */
export const FSPL_CONST = -147.55;

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

export const TWO_PI = Math.PI * 2;

/**
 * Air density from the ideal gas law at a given altitude, temperature and
 * sea-level pressure. Used by the aero model — density falls ~12% at 1 km.
 */
export function airDensity(altitudeMeters: number, temperatureC: number, pressureHpa?: number): number {
  const temperatureK = temperatureC + 273.15;
  const pressurePa = (pressureHpa ?? pressureAtAltitude(altitudeMeters)) * 100;
  return pressurePa / (R_SPECIFIC_AIR * temperatureK);
}

/** Pressure at altitude under the ISA troposphere model. */
export function pressureAtAltitude(altitudeMeters: number, seaLevelHpa = 1013.25): number {
  const exponent = (GRAVITY / (R_SPECIFIC_AIR * 288.15) - 1) * -1;
  return seaLevelHpa * Math.pow(1 - (altitudeMeters * 0.0065) / 288.15, -exponent);
}

/** Temperature offset from ISA (°C). Negative below the standard lapse layer. */
export function isaTemperatureOffset(altitudeMeters: number): number {
  return -0.0065 * altitudeMeters;
}

/** RPM → rad/s. The single most-used conversion in the motor model. */
export const rpmToRadPerSec = (rpm: number): number => (rpm * TWO_PI) / 60;

/** rad/s → RPM. */
export const radPerSecToRpm = (radPerSec: number): number => (radPerSec * 60) / TWO_PI;

/** Inches → metres. Prop sizes are quoted in inches, everything else in metres. */
export const inchToMeter = (inches: number): number => inches * 0.0254;

/** Grams → kilograms. */
export const gramsToKg = (grams: number): number => grams / 1000;

/** Milli-ohm → ohm. */
export const milliOhmToOhm = (milliOhm: number): number => milliOhm / 1000;

/** dBm → mW (radio link budgets work in dBm). */
export const dbmToMilliwatt = (dbm: number): number => Math.pow(10, dbm / 10);

/** mW → dBm. */
export const milliwattToDbm = (mw: number): number => 10 * Math.log10(Math.max(mw, 1e-12));
