/**
 * Application store.
 *
 * The `World` is a plain mutable object held *outside* React — it changes 500
 * times a second and must never trigger a render. React gets a snapshot that is
 * republished at `SIM_UI_HZ` (20 Hz), which is the rate a human can actually
 * read and the rate a mid-range phone can afford to re-render at.
 *
 * The render loop lives here too, so there is exactly one place that owns the
 * frame order: poll input → step the world → publish the snapshot → draw.
 */

import { create } from 'zustand';
import { toControlInput, SURFACE_LABELS } from '../input/types';
import type { Binding, ControlSurface } from '../input/types';
import { InputManager } from '../input/manager';
import type { AxisCalibration, StickAxis } from '../input/mapping';
import type { InputDeviceInfo } from '../input/types';
import { findBuild } from '../core/parts/presets';
import type { BuildSpec, PartId, PartSlot } from '../core/parts';
import { World, type WorldSnapshot } from '../core/sim/world';
import { DEFAULT_SETTINGS, applySettingsPreset, type SimSettings } from '../core/sim/settings';
import { DEFAULT_WIND, type WindSettings } from '../core/sim/wind';
import { DEFAULT_WEATHER, type WeatherSettings } from '../core/sim/weather';
import { TUNE_PRESETS, applyPreset, type TuningState } from '../core/tuning/tuner';
import { SceneRenderer, type CameraMode } from '../render/scene';

/** How often the UI snapshot is republished, Hz. */
export const SIM_UI_HZ = 20;

export type PanelId = 'fly' | 'builder' | 'tuner' | 'controls' | 'settings' | 'map';

export interface StoreState {
  // --- Live simulation (not React state) ---------------------------------
  world: World;
  renderer: SceneRenderer | null;
  input: InputManager;

  // --- Published UI snapshot --------------------------------------------
  snapshot: WorldSnapshot | null;
  device: InputDeviceInfo;

  // --- UI state -----------------------------------------------------------
  panel: PanelId;
  cameraMode: CameraMode;
  slot: PartSlot;
  paused: boolean;
  showHud: boolean;
  buildName: string;
  build: BuildSpec;
  settings: SimSettings;
  tune: TuningState;
  tunePresetId: string;
  weather: WeatherSettings;
  wind: WindSettings;
  seed: string;
  timeOfDay: number;
  /** Message shown as a toast, e.g. "Radio connected". */
  toast: { id: number; text: string; tone: 'info' | 'warn' | 'good' } | null;
  /** Arm blocked because the build is invalid. */
  armError: string | null;
  /** Physical control assigned to each surface. Empty means the default layout. */
  bindings: Partial<Record<ControlSurface, Binding>>;
}


const initialBuild = findBuild('preset-freestyle-5-analog');

/** Read the current store. Shorthand used by the actions below. */
const get = () => useStore.getState();

export const useStore = create<StoreState>(() => ({
  world: new World(initialBuild, { seed: 'fpv-lab' }, DEFAULT_SETTINGS),
  renderer: null,
  input: null as unknown as InputManager,

  snapshot: null,
  device: { kind: 'none', id: 'Starting…', connected: false },

  panel: 'fly',
  cameraMode: 'fpv',
  slot: 'frame',
  paused: false,
  showHud: true,
  buildName: initialBuild.name,
  build: initialBuild,
  settings: DEFAULT_SETTINGS,
  tune: null as unknown as TuningState,
  tunePresetId: 'tune-freestyle',
  weather: { ...DEFAULT_WEATHER },
  wind: { ...DEFAULT_WIND },
  seed: 'fpv-lab',
  timeOfDay: 16,
  toast: null,
  armError: null,
  bindings: {},
}));

let toastId = 0;
let publishAccumulator = 0;
let rafHandle = 0;
let lastFrameTime = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Publish a short-lived toast message. */
export const notify = (text: string, tone: 'info' | 'warn' | 'good' = 'info'): void => {
  toastId += 1;
  useStore.setState({ toast: { id: toastId, text, tone } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    useStore.setState({ toast: null });
  }, 2800);
};

/**
 * The single frame loop. Input → physics → slow systems → publish → draw.
 */
export function startLoop(canvas: HTMLCanvasElement, input: InputManager): void {
  const renderer = new SceneRenderer(canvas, get().world);
  const resize = (): void => {
    const parent = canvas.parentElement;
    renderer.resize(parent?.clientWidth ?? window.innerWidth, parent?.clientHeight ?? window.innerHeight);
  };
  resize();
  window.addEventListener('resize', resize);

  const state = get();
  useStore.setState({
    renderer,
    input,
    tune: state.world.tune,
    weather: state.world.weather.weather,
    wind: state.world.wind.settings,
    snapshot: state.world.snapshot(),
  });

  lastFrameTime = performance.now();

  const frame = (now: number): void => {
    rafHandle = requestAnimationFrame(frame);
    const dt = Math.min((now - lastFrameTime) / 1000, 0.25);
    lastFrameTime = now;

    const store = get();
    const { world } = store;

    // 1. Input
    const inputFrame = store.input.poll(dt, world.snapshot().time);
    store.input.setConfig({
      preferred: store.input.settings.preferred,
    });
    const control = toControlInput(inputFrame);

    // 2. Arm switch, edge-triggered so holding it does not toggle repeatedly.
    const armPressed = inputFrame.switches.armSwitch;
    if (armPressed && !store.world.armLatch) {
      if (world.phase === 'flying' || world.phase === 'armed') world.disarm();
      else world.arm();
      store.world.armLatch = true;
    } else if (!armPressed) {
      store.world.armLatch = false;
    }

    // 3. Physics
    if (!store.paused) {
      world.step(dt, control);
      world.tickSlow(dt);
    }

    // 4. Publish at the UI rate, not the frame rate.
    publishAccumulator += dt;
    const period = 1 / SIM_UI_HZ;
    if (publishAccumulator >= period) {
      publishAccumulator = 0;
      const snapshot = world.snapshot();
      const device = store.input.info();
      // Only write when something the UI shows has actually changed.
      useStore.setState({ snapshot, device, tune: world.tune });
    }

    // 5. Draw at full rate.
    const latest = world.snapshot();
    renderer.render(dt, latest);
  };

  rafHandle = requestAnimationFrame(frame);

  // Resuming from a background tab must not integrate a huge dt.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lastFrameTime = performance.now();
  });
}

export function stopLoop(): void {
  cancelAnimationFrame(rafHandle);
  get().renderer?.dispose();
}

// ---------------------------------------------------------------------------
// Actions. Each one mutates the world outside React, then publishes the
// derived state the panels read.
// ---------------------------------------------------------------------------

export const actions = {
  setPanel(panel: PanelId): void {
    useStore.setState({ panel });
  },

  setCameraMode(cameraMode: CameraMode): void {
    get().renderer?.setMode(cameraMode);
    useStore.setState({ cameraMode });
  },

  setSlot(slot: PartSlot): void {
    useStore.setState({ slot });
  },

  togglePause(): void {
    const paused = !get().paused;
    if (!paused) get().input.neutralize();
    useStore.setState({ paused });
  },

  toggleHud(): void {
    useStore.setState({ showHud: !get().showHud });
  },

  /** Fit a part into a slot, re-resolving the build. */
  setPart(slot: PartSlot, partId: PartId | null): void {
    const store = get();
    const next: BuildSpec = {
      ...store.build,
      id: 'custom',
      name: store.build.name,
      slots: { ...store.build.slots },
    };
    if (partId === null) delete next.slots[slot];
    else next.slots[slot] = partId;

    store.world.setBuild(next);
    useStore.setState({
      build: next,
      tune: store.world.tune,
      snapshot: store.world.snapshot(),
    });
  },

  loadPreset(id: string): void {
    const store = get();
    const preset = findBuild(id);
    store.world.setBuild(preset);
    useStore.setState({
      build: preset,
      buildName: preset.name,
      tune: store.world.tune,
      snapshot: store.world.snapshot(),
    });
    notify(`Loaded ${preset.name}`, 'good');
  },

  toggleArm(): void {
    const { world } = get();
    if (world.phase === 'flying' || world.phase === 'armed') {
      world.disarm();
    } else {
      world.arm();
      if (world.phase === 'disarmed') {
        notify('Build has errors — see the Builder panel', 'warn');
      }
    }
    useStore.setState({ snapshot: world.snapshot() });
  },

  reset(): void {
    get().world.reset();
    get().input.neutralize();
    useStore.setState({ snapshot: get().world.snapshot() });
  },

  setSettings(patch: Partial<SimSettings>): void {
    const store = get();
    const settings = { ...store.settings, ...patch };
    store.world.setSettings(settings);
    useStore.setState({ settings, snapshot: store.world.snapshot() });
  },

  applySettingsPreset(id: string): void {
    actions.setSettings(applySettingsPreset(id));
    notify('Simulation settings applied');
  },

  setWeather(patch: Partial<WeatherSettings>): void {
    const store = get();
    const weather = { ...store.weather, ...patch };
    store.world.weather.weather = { ...weather };
    useStore.setState({ weather, snapshot: store.world.snapshot() });
  },

  setWind(patch: Partial<WindSettings>): void {
    const store = get();
    const wind = { ...store.wind, ...patch };
    store.world.wind.settings = { ...wind };
    // The weather model is what the HUD and sky read, so mirror the fields it
    // owns rather than letting the two drift apart.
    store.world.weather.windSpeed = wind.speed;
    store.world.weather.windDirectionDeg = ((wind.directionRad * 180) / Math.PI + 360) % 360;
    useStore.setState({ wind, snapshot: store.world.snapshot() });
  },

  setTimeOfDay(hours: number): void {
    const store = get();
    store.world.weather.setTime(hours);
    useStore.setState({ timeOfDay: hours, snapshot: store.world.snapshot() });
  },

  setSeed(seed: string): void {
    const store = get();
    // Rebuilding the world is expensive, so it is explicit rather than reactive.
    store.world.terrain.config.seed = seed;
    store.renderer?.rebuildWorld();
    useStore.setState({ seed, snapshot: store.world.snapshot() });
  },

  setPilotPosition(id: string): void {
    const store = get();
    const point = store.world.terrain.launchPoints.find((p) => p.id === id);
    if (!point) return;
    store.world.setPilotPosition(point);
    store.world.reset();
    useStore.setState({ snapshot: store.world.snapshot() });
    notify(`Pilot at ${point.name}`, 'info');
  },

  /** Apply a tune preset from the tuner panel. */
  setTunePreset(id: string): void {
    const store = get();
    const preset = TUNE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    applyPreset(store.world.tune, preset);
    useStore.setState({ tunePresetId: id, tune: store.world.tune });
    notify(`Tune: ${preset.name}`, 'good');
  },

  /** Patch a PID gain. */
  setPid(axis: 'roll' | 'pitch' | 'yaw', term: 'p' | 'i' | 'd' | 'f', value: number): void {
    const store = get();
    const tune = store.world.tune;
    tune.pid[axis][term] = value;
    useStore.setState({ tune: { ...tune } });
  },

  setRate(
    axis: 'roll' | 'pitch' | 'yaw',
    term: 'center' | 'max' | 'expo',
    value: number,
  ): void {
    const store = get();
    store.world.tune.rates[axis][term] = value;
    useStore.setState({ tune: { ...store.world.tune } });
  },

  setFilter(
    term: 'gyroLowpassHz' | 'dtermLowpassHz' | 'notchHz' | 'notchQ',
    value: number,
  ): void {
    const store = get();
    store.world.tune.filters[term] = value;
    useStore.setState({ tune: { ...store.world.tune } });
  },

  async connectRadio(): Promise<void> {
    const store = get();
    const ok = await store.input.connectRadio();
    if (ok) notify('Radio connected', 'good');
    else notify('Radio not connected — using ' + store.input.info().id, 'warn');
    useStore.setState({ device: store.input.info() });
  },

  cycleDriver(): void {
    const store = get();
    const kind = store.input.cycleDriver();
    notify(`Input: ${store.input.info().id || kind}`);
    useStore.setState({ device: store.input.info() });
  },

  setStickMode(mode: 1 | 2 | 3 | 4): void {
    const store = get();
    store.input.setConfig({ stickMode: mode });
    store.input.touch.setMode(mode);
    notify(`Stick mode ${mode}`, 'good');
    useStore.setState({});
  },

  setCalibration(
    axis: StickAxis,
    term: keyof AxisCalibration,
    value: number | boolean,
  ): void {
    const store = get();
    const current = store.input.settings.calibration;
    store.input.setConfig({
      calibration: {
        ...current,
        [axis]: { ...current[axis], [term]: value },
      },
    });
    useStore.setState({});
  },

  setGestureArm(enabled: boolean): void {
    get().input.setConfig({ gestureArm: enabled });
    useStore.setState({});
  },

  /**
   * Bind a control surface to a physical control. This is the "Listen" capture
   * in the controls panel: the pilot presses the button, moves the control, and
   * the panel tells us what moved.
   */
  assignBinding(surface: PartSlot | ControlSurface, binding: Binding): void {
    const bindings = { ...get().bindings };
    bindings[surface as ControlSurface] = binding;
    // The manager holds the live copy it reads each poll; the store copy is only
    // what the panel renders.
    get().input.setBindings(bindings);
    useStore.setState({ bindings });
    notify(`${SURFACE_LABELS[surface as ControlSurface]} bound`, 'good');
  },

  clearBinding(surface: ControlSurface): void {
    const bindings = { ...get().bindings };
    delete bindings[surface];
    get().input.setBindings(bindings);
    useStore.setState({ bindings });
  },

  resetBindings(): void {
    get().input.setBindings({});
    useStore.setState({ bindings: {} });
    notify('Control bindings cleared');
  },
};
