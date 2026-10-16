/**
 * Weather and time of day.
 *
 * The sun position is real astronomy: solar declination from the day of year,
 * hour angle from local solar time, then an elevation/azimuth transform for the
 * map's latitude. That means a winter flight at a high latitude really does have
 * a low sun, long shadows, and a cold battery, and that flying into the sun at
 * low elevation really does blind the camera.
 */

import { DEG2RAD, RAD2DEG } from '../constants';
import { clamp, smoothstep } from '../math/vec3';
import { fbm1 } from '../math/noise';

export interface WeatherSettings {
  /** Rainfall rate, mm per hour. */
  rainMmPerHour: number;
  /** Cloud cover, 0..1. */
  cloudCover: number;
  /** Ambient temperature, °C. */
  temperatureC: number;
  /** Relative humidity, 0..1. Affects condensation on the lens. */
  humidity: number;
  /** Fog / haze density, 0..1. Reduces visibility. */
  haze: number;
}

export const DEFAULT_WEATHER: WeatherSettings = {
  rainMmPerHour: 0,
  cloudCover: 0.35,
  temperatureC: 18,
  humidity: 0.5,
  haze: 0.12,
};

export interface SunState {
  /** Elevation above the horizon, radians. Negative = night. */
  elevationRad: number;
  /** Compass azimuth in radians, 0 = north, increasing clockwise. */
  azimuthRad: number;
  /** Unit vector towards the sun in world space (x = east, y = up, z = south). */
  direction: { x: number; y: number; z: number };
  /** Irradiance at the ground, W/m². */
  irradiance: number;
  /** Colour temperature, K. Dawn/dusk are red because the path through the atmosphere is long. */
  colorTemperatureK: number;
  /** Daylight factor 0..1. */
  daylight: number;
}

export interface SkyState {
  /** Zenith colour, linear RGB 0..1. */
  zenith: { r: number; g: number; b: number };
  /** Horizon colour, linear RGB 0..1. */
  horizon: { r: number; g: number; b: number };
  /** Sun colour, linear RGB 0..1. */
  sunColor: { r: number; g: number; b: number };
  /** Ambient light colour, linear RGB 0..1. */
  ambient: { r: number; g: number; b: number };
  /** Fog colour for the scene, linear RGB 0..1. */
  fog: { r: number; g: number; b: number };
  /** Distance at which fog fully obscures, metres. */
  fogDistance: number;
}

export interface WeatherSnapshot {
  sun: SunState;
  sky: SkyState;
  /** Wind speed at reference height, m/s. */
  windSpeed: number;
  windDirectionDeg: number;
  /** 0 = calm, 1 = storm. */
  turbulence: number;
  rainMmPerHour: number;
  temperatureC: number;
  humidity: number;
  /** Visibility, metres. */
  visibilityM: number;
  /** Clock time as hours 0..24. */
  timeOfDayHours: number;
  /** Air density from temperature and pressure at the current altitude. */
  airDensity: number;
  clockLabel: string;
}

/**
 * Solar position for a given day of year, local solar time and latitude.
 * Standard low-precision solar position algorithm (accurate to ~0.1°), which is
 * far more than a flight simulator needs.
 */
export function solarPosition(
  dayOfYear: number,
  localSolarHour: number,
  latitudeDeg: number,
): { elevationRad: number; azimuthRad: number } {
  // Solar declination, radians. Zero at the equinoxes, +23.4° at the summer
  // solstice around day 172, −23.4° at the winter solstice around day 355.
  const declination = 0.409 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 80));
  // Hour angle: 0 at solar noon, negative in the morning.
  const hourAngle = (localSolarHour - 12) * 15 * DEG2RAD;
  const latitude = latitudeDeg * DEG2RAD;

  const sinElevation =
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(clamp(sinElevation, -1, 1));

  // Azimuth measured clockwise from north: 0 = north, π/2 = east, π = south.
  const cosAzimuth =
    (Math.sin(declination) - Math.sin(elevation) * Math.sin(latitude)) /
    Math.max(Math.cos(elevation) * Math.cos(latitude), 1e-6);
  const fromNorth = Math.acos(clamp(cosAzimuth, -1, 1));
  // acos only spans the northern half of the circle; the afternoon sun is in
  // the western half, so mirror it.
  const azimuth = Math.sin(hourAngle) > 0 ? Math.PI * 2 - fromNorth : fromNorth;

  return { elevationRad: elevation, azimuthRad: azimuth };
}

/** Planck's law approximated for the visible band, returns linear RGB. */
function colorFromTemperature(kelvin: number, intensity: number): { r: number; g: number; b: number } {
  // Simple piecewise fit — plenty for a renderer that tone-maps afterwards.
  const t = clamp(kelvin, 1800, 12000) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66.5) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const norm = (v: number) => clamp(v / 255, 0, 1) ** 2.2 * intensity;
  return { r: norm(r), g: norm(g), b: norm(b) };
}

/**
 * Weather model. Holds the clock, the sky and everything the renderer and the
 * physics need to agree on.
 */
export class Weather {
  weather: WeatherSettings;
  /** Hours, 0..24. */
  timeOfDayHours: number;
  dayOfYear: number;
  latitudeDeg: number;
  /** Wind speed at reference height, m/s. */
  windSpeed: number;
  /** Direction the wind comes FROM, compass degrees. */
  windDirectionDeg: number;

  constructor(
    weather: WeatherSettings = DEFAULT_WEATHER,
    timeOfDayHours = 16,
    dayOfYear = 172,
    latitudeDeg = 47,
  ) {
    this.weather = { ...weather };
    this.timeOfDayHours = timeOfDayHours;
    this.dayOfYear = dayOfYear;
    this.latitudeDeg = latitudeDeg;
    this.windSpeed = 5;
    this.windDirectionDeg = 45;
  }

  setTime(hours: number): void {
    this.timeOfDayHours = ((hours % 24) + 24) % 24;
  }

  /** Advance the clock, wrapping at midnight. */
  advance(deltaHours: number): void {
    this.setTime(this.timeOfDayHours + deltaHours);
  }

  get sun(): SunState {
    const { elevationRad, azimuthRad } = solarPosition(
      this.dayOfYear,
      this.timeOfDayHours,
      this.latitudeDeg,
    );
    const cosEl = Math.cos(elevationRad);
    const sinEl = Math.sin(elevationRad);
    // World frame: x = east, y = up, z = south. Azimuth 0 = north (−z).
    const direction = {
      x: cosEl * Math.sin(azimuthRad),
      y: sinEl,
      z: cosEl * Math.cos(azimuthRad),
    };

    // Air mass through the atmosphere, clipped below the horizon.
    const airMass = sinEl > 0.01 ? 1 / sinEl : 40;
    const clearSky = 1055 * Math.pow(0.7, Math.pow(airMass, 0.678));
    const cloudFactor = 1 - this.weather.cloudCover * 0.65;
    const irradiance = sinEl > 0 ? clearSky * cloudFactor : 0;

    // Low sun means a long atmospheric path: redder and dimmer.
    const pathT = clamp(1 - sinEl, 0, 1);
    const colorTemperatureK = 6200 - pathT * 4200;

    return {
      elevationRad,
      azimuthRad,
      direction,
      irradiance,
      colorTemperatureK,
      daylight: clamp(smoothstep(-0.12, 0.18, sinEl), 0, 1),
    };
  }

  get sky(): SkyState {
    const sun = this.sun;
    const { cloudCover, haze } = this.weather;

    // Zenith deepens as the sun drops; horizon keeps a warm band at low sun.
    const twilight = clamp(smoothstep(-0.25, 0.35, Math.sin(sun.elevationRad)), 0, 1);
    const zenith: { r: number; g: number; b: number } = {
      r: 0.05 + twilight * 0.12,
      g: 0.1 + twilight * 0.25,
      b: 0.3 + twilight * 0.45,
    };
    const horizonWarmth = clamp(1 - Math.sin(sun.elevationRad) * 3, 0, 1);
    const horizon: { r: number; g: number; b: number } = {
      r: 0.25 + twilight * 0.5 + horizonWarmth * 0.2,
      g: 0.3 + twilight * 0.35 + horizonWarmth * 0.05,
      b: 0.42 + twilight * 0.3 - horizonWarmth * 0.15,
    };

    const sunColor = colorFromTemperature(sun.colorTemperatureK, clamp(sun.daylight * 1.4, 0, 1));

    // Rain and cloud grey out the sky.
    const wet = clamp(this.weather.rainMmPerHour / 12, 0, 1);
    const desaturate = (c: { r: number; g: number; b: number }, amount: number) => {
      const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
      return {
        r: c.r * (1 - amount) + lum * amount,
        g: c.g * (1 - amount) + lum * amount,
        b: c.b * (1 - amount) + lum * amount,
      };
    };
    const grey = clamp(cloudCover * 0.45 + wet * 0.45, 0, 0.9);
    const finalZenith = desaturate(zenith, grey);
    const finalHorizon = desaturate(horizon, grey * 0.7);

    const ambient = {
      r: finalZenith.r * 0.4 + finalHorizon.r * 0.2 + 0.03,
      g: finalZenith.g * 0.4 + finalHorizon.g * 0.2 + 0.035,
      b: finalZenith.b * 0.4 + finalHorizon.b * 0.2 + 0.05,
    };

    // Visibility: rain, haze and cloud all cut it. Heavy rain on a 5" quad is
    // genuinely disorienting past ~300 m.
    const visibilityM =
      12000 * Math.exp(-(haze * 2.4 + wet * 1.1 + cloudCover * 0.12));

    const fog = {
      r: finalHorizon.r * 0.9 + 0.05,
      g: finalHorizon.g * 0.9 + 0.05,
      b: finalHorizon.b * 0.9 + 0.06,
    };

    return {
      zenith: finalZenith,
      horizon: finalHorizon,
      sunColor,
      ambient,
      fog,
      fogDistance: Math.max(visibilityM, 60),
    };
  }

  snapshot(altitudeM: number, airDensityAt: (alt: number, temp: number) => number): WeatherSnapshot {
    const sun = this.sun;
    const sky = this.sky;
    const { rainMmPerHour, temperatureC, humidity } = this.weather;

    // Gusts scale with wind speed; the 0.7 exponent matches the roughly
    // 1/7 power law from mean wind speed to peak gust speed.
    const turbulence = clamp(Math.pow(this.windSpeed / 25, 0.7), 0, 1);

    return {
      sun,
      sky,
      windSpeed: this.windSpeed,
      windDirectionDeg: this.windDirectionDeg,
      turbulence,
      rainMmPerHour,
      temperatureC,
      humidity,
      visibilityM: sky.fogDistance,
      timeOfDayHours: this.timeOfDayHours,
      airDensity: airDensityAt(altitudeM, temperatureC),
      clockLabel: formatClock(this.timeOfDayHours),
    };
  }
}

/** 24 h clock as HH:MM. */
export function formatClock(hours: number): string {
  const h = Math.floor(((hours % 24) + 24) % 24);
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/** Compass bearing label, e.g. "045° NE". */
export function compassLabel(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${Math.round(d).toString().padStart(3, '0')}° ${points[Math.round(d / 45) % 8]}`;
}

/**
 * Wind instability. Surface heating on a sunny day makes the boundary layer
 * turbulent and the wind less steady; overcast winter air is much calmer.
 */
export function inferredStability(settings: WeatherSettings, sun: SunState): number {
  const heating = sun.daylight * (1 - settings.cloudCover);
  const nocturnalStability = clamp(settings.humidity, 0, 1) * 0.3;
  return clamp(0.45 + heating * 0.3 - nocturnalStability, 0, 1);
}

/** Slow-drifting synthetic weather over a session, deterministic per day. */
export function ambientWeatherFor(dayOfYear: number, timeHours: number): WeatherSettings {
  const seed = dayOfYear * 131 + Math.floor(timeHours);
  const rain = Math.max(0, fbm1(seed * 0.37, 3, dayOfYear) * 18 - 6);
  const cloud = clamp(fbm1(seed * 0.21, 4, dayOfYear + 17) * 0.5 + 0.5, 0, 1);
  const baseTemp = 16 + 9 * Math.sin(((dayOfYear - 105) / 365) * 2 * Math.PI);
  const diurnal = -4.5 * Math.cos(((timeHours - 15) / 24) * 2 * Math.PI);
  return {
    rainMmPerHour: rain,
    cloudCover: cloud,
    temperatureC: baseTemp + diurnal - cloud * 3,
    humidity: clamp(0.45 + fbm1(seed * 0.13, 2, dayOfYear + 5) * 0.4, 0.15, 1),
    haze: clamp(0.08 + fbm1(seed * 0.09, 2, dayOfYear + 41) * 0.22, 0, 1),
  };
}

export { RAD2DEG };
