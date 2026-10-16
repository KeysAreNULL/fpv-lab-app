/**
 * Simulation toggles. Every optional system reads its flag at the top of the
 * step and early-returns when off, leaving snapshot fields at neutral defaults.
 * Disabling a flag must be a no-op, never a NaN generator.
 */

export interface SimSettings {
  // --- Damage -----------------------------------------------------------
  /** Master switch for all part damage. */
  partsDamage: boolean;
  /** Frame structural damage from impacts. */
  frameDamage: boolean;
  /** Electronics damage — FC/ESC/VTX degradation. */
  electronicsDamage: boolean;
  /** Prop damage — thrust loss, imbalance and vibration. */
  propDamage: boolean;
  /** Camera damage — noise, dead pixels, blocking the lens. */
  cameraDamage: boolean;

  // --- Signal -----------------------------------------------------------
  /** Master switch for all link simulation. */
  signalStrength: boolean;
  /** Video downlink degradation into analog snow / digital dropouts. */
  videoSignal: boolean;
  /** Control-link RSSI and LQ, including failsafe. */
  radioSignal: boolean;
  /** Attenuation as the link passes through buildings and terrain. */
  rfPenetration: boolean;
  /** Multipath fading as the drone moves behind obstacles. */
  multipath: boolean;

  // --- Power ------------------------------------------------------------
  /** Battery voltage sag under load. Off = flat nominal voltage. */
  batterySag: boolean;
  /** Battery heat and internal resistance rising as it cools/empties. */
  batteryThermal: boolean;

  // --- Environment ------------------------------------------------------
  /** Wind, gusts and turbulence. */
  weather: boolean;
  /** Rain: extra drag, prop efficiency loss, wet-lens effect. */
  rain: boolean;
  /** Cloud cover and visibility loss. */
  fog: boolean;
  /** Sun position, sky colour and shadow direction from the clock. */
  timeOfDay: boolean;
  /** Air density varying with altitude and temperature. */
  airDensity: boolean;

  // --- Flight assistance ------------------------------------------------
  /** Simulated propwash and its effect on the airframe. */
  propwash: boolean;
  /** Advanced failsafe behaviour on control-link loss. */
  failsafe: boolean;
}

export const DEFAULT_SETTINGS: SimSettings = {
  partsDamage: true,
  frameDamage: true,
  electronicsDamage: true,
  propDamage: true,
  cameraDamage: true,

  signalStrength: true,
  videoSignal: true,
  radioSignal: true,
  rfPenetration: true,
  multipath: true,

  batterySag: true,
  batteryThermal: true,

  weather: true,
  rain: true,
  fog: true,
  timeOfDay: true,
  airDensity: true,

  propwash: true,
  failsafe: true,
};

/**
 * Named presets for the settings panel. Each is a complete configuration so the
 * user can get to "just the physics I care about" in one tap.
 */
export interface SettingsPreset {
  id: string;
  name: string;
  description: string;
  settings: Partial<SimSettings>;
}

export const SETTINGS_PRESETS: readonly SettingsPreset[] = [
  {
    id: 'preset-full',
    name: 'Full Simulation',
    description: 'Everything on. The most realistic and most demanding.',
    settings: {},
  },
  {
    id: 'preset-clean',
    name: 'Clean Build',
    description: 'Damage, weather and battery wear off. Physics and video stay on.',
    settings: {
      partsDamage: false,
      weather: false,
      batteryThermal: false,
      propDamage: false,
      frameDamage: false,
      electronicsDamage: false,
    },
  },
  {
    id: 'preset-nodamage',
    name: 'Endurance',
    description: 'No part damage but weather, signal and battery are all live.',
    settings: {
      partsDamage: false,
      frameDamage: false,
      electronicsDamage: false,
      propDamage: false,
      cameraDamage: false,
    },
  },
  {
    id: 'preset-cruise',
    name: 'Perfect Link',
    description: 'No signal loss. Good for practising lines and tuning rates.',
    settings: { signalStrength: false },
  },
  {
    id: 'preset-bench',
    name: 'Bench Test',
    description: 'Bare airframe. Damage, weather, signal, sag and wear all off.',
    settings: {
      partsDamage: false,
      frameDamage: false,
      electronicsDamage: false,
      propDamage: false,
      cameraDamage: false,
      signalStrength: false,
      batterySag: false,
      batteryThermal: false,
      weather: false,
      rain: false,
      fog: false,
      timeOfDay: false,
      airDensity: false,
      propwash: false,
      failsafe: false,
    },
  },
  {
    id: 'preset-rain',
    name: 'Wet Multirotor',
    description: 'Rain and low battery, no signal or damage. The cinematic survival test.',
    settings: {
      partsDamage: false,
      frameDamage: false,
      electronicsDamage: false,
      propDamage: false,
      cameraDamage: false,
      signalStrength: false,
    },
  },
];

/** Merge a preset over the defaults, returning a complete settings object. */
export const applySettingsPreset = (id: string): SimSettings => {
  const preset = SETTINGS_PRESETS.find((p) => p.id === id);
  return preset ? { ...DEFAULT_SETTINGS, ...preset.settings } : { ...DEFAULT_SETTINGS };
};

/** How many systems are currently enabled — shown in the settings header. */
export const countEnabled = (settings: SimSettings): number =>
  Object.values(settings).filter(Boolean).length;
