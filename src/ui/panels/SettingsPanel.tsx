import { useMemo } from 'react';
import {
  SETTINGS_PRESETS,
  countEnabled,
  type SimSettings,
} from '../../core/sim/settings';
import { actions, useStore } from '../../state/store';
import { Card, PanelHead, Slider, Stat, Switch } from '../components';

/** Grouped toggles. Every one of these is read at the top of a sim step. */
const GROUPS: {
  title: string;
  master?: keyof SimSettings;
  entries: { key: keyof SimSettings; label: string; description: string }[];
}[] = [
  {
    title: 'Parts damage',
    master: 'partsDamage',
    entries: [
      { key: 'frameDamage', label: 'Frame', description: 'Arms bend and drag goes up. A bent arm makes the drone drift.' },
      { key: 'propDamage', label: 'Props', description: 'Chips cost thrust and add drag, then throw a violent vibration.' },
      { key: 'electronicsDamage', label: 'Electronics', description: 'Gyro noise and reduced control authority; ESC desyncs.' },
      { key: 'cameraDamage', label: 'Camera', description: 'Cracks, dead pixels and a fogged lens in the video feed.' },
    ],
  },
  {
    title: 'Signal strength',
    master: 'signalStrength',
    entries: [
      { key: 'videoSignal', label: 'Video downlink', description: 'Analog snow and rolling tear; digital frame drops then black.' },
      { key: 'radioSignal', label: 'Control link', description: 'RSSI and link quality, plus failsafe stages.' },
      { key: 'rfPenetration', label: 'RF penetration', description: 'Loss through buildings, terrain and foliage, with Fresnel diffraction.' },
      { key: 'multipath', label: 'Multipath fading', description: 'The deep fades you get flying around structures.' },
    ],
  },
  {
    title: 'Battery',
    entries: [
      { key: 'batterySag', label: 'Voltage sag', description: 'The pack sags under load and every motor loses thrust with it.' },
      { key: 'batteryThermal', label: 'Heat and wear', description: 'I²R heating, cold-pack resistance and permanent capacity loss.' },
    ],
  },
  {
    title: 'Weather & sky',
    entries: [
      { key: 'weather', label: 'Wind', description: 'Boundary-layer shear, gusts and obstacle turbulence.' },
      { key: 'rain', label: 'Rain', description: 'Extra drag, wet props, and the lens fogs over time.' },
      { key: 'fog', label: 'Haze & visibility', description: 'Distance fade and the visibility readout.' },
      { key: 'timeOfDay', label: 'Time of day', description: 'Real solar position for the sun angle, colour and shadows.' },
      { key: 'airDensity', label: 'Air density', description: 'Thinner air with altitude and cold: less thrust, more drag.' },
    ],
  },
  {
    title: 'Flight behaviour',
    entries: [
      { key: 'propwash', label: 'Propwash', description: 'Downwash from the props disturbing the airframe.' },
      { key: 'failsafe', label: 'Failsafe', description: 'What happens when the control link is genuinely lost.' },
    ],
  },
];

export function SettingsPanel(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const weather = useStore((s) => s.weather);
  const wind = useStore((s) => s.wind);
  const timeOfDay = useStore((s) => s.timeOfDay);
  const seed = useStore((s) => s.seed);
  const snapshot = useStore((s) => s.snapshot);

  const enabled = useMemo(() => countEnabled(settings), [settings]);

  return (
    <div className="panel wide">
      <PanelHead title="Simulation">
        <span className="label">{enabled} systems on</span>
      </PanelHead>

      <Card title="Presets">
        <div className="row">
          {SETTINGS_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="btn small"
              title={preset.description}
              onClick={() => actions.applySettingsPreset(preset.id)}
            >
              {preset.name}
            </button>
          ))}
        </div>
        <div className="switch-desc" style={{ marginTop: 6 }}>
          Every toggle below gates a real system. Turning one off makes it a no-op —
          the simulation stops paying for it rather than producing different
          numbers.
        </div>
      </Card>

      <div className="grid" style={{ marginTop: 10 }}>
        {GROUPS.map((group) => (
          <Card key={group.title} title={group.title}>
            {group.master ? (
              <Switch
                label={`All ${group.title.toLowerCase()}`}
                checked={Boolean(settings[group.master])}
                onChange={(next) => actions.setSettings({ [group.master as string]: next })}
              />
            ) : null}
            {group.entries.map((entry) => {
              const master = group.master ? Boolean(settings[group.master]) : true;
              return (
                <Switch
                  key={entry.key}
                  label={entry.label}
                  description={entry.description}
                  checked={Boolean(settings[entry.key]) && master}
                  disabled={group.master ? !settings[group.master] : false}
                  onChange={(next) => actions.setSettings({ [entry.key]: next })}
                />
              );
            })}
          </Card>
        ))}

        <Card title="Weather">
          <Slider
            label="Rainfall"
            value={weather.rainMmPerHour}
            min={0}
            max={40}
            step={0.5}
            decimals={1}
            unit=" mm/h"
            onChange={(next) => actions.setWeather({ rainMmPerHour: next })}
          />
          <Slider
            label="Cloud cover"
            value={weather.cloudCover}
            min={0}
            max={1}
            step={0.02}
            onChange={(next) => actions.setWeather({ cloudCover: next })}
          />
          <Slider
            label="Temperature"
            value={weather.temperatureC}
            min={-15}
            max={42}
            step={0.5}
            decimals={1}
            unit=" °C"
            onChange={(next) => actions.setWeather({ temperatureC: next })}
          />
          <Slider
            label="Humidity"
            value={weather.humidity}
            min={0}
            max={1}
            step={0.02}
            onChange={(next) => actions.setWeather({ humidity: next })}
          />
          <Slider
            label="Haze"
            value={weather.haze}
            min={0}
            max={1}
            step={0.02}
            onChange={(next) => actions.setWeather({ haze: next })}
          />
        </Card>

        <Card title="Wind">
          <Slider
            label="Speed"
            value={wind.speed}
            min={0}
            max={30}
            step={0.5}
            decimals={1}
            unit=" m/s"
            onChange={(next) => actions.setWind({ speed: next })}
          />
          <Slider
            label="Direction (from)"
            value={((wind.directionRad * 180) / Math.PI + 360) % 360}
            min={0}
            max={359}
            step={1}
            decimals={0}
            unit="°"
            onChange={(next) => actions.setWind({ directionRad: (next * Math.PI) / 180 })}
          />
          <Slider
            label="Stability"
            value={wind.stability}
            min={0}
            max={1}
            step={0.05}
            onChange={(next) => actions.setWind({ stability: next })}
          />
          <Slider
            label="Gustiness"
            value={wind.gustiness}
            min={0}
            max={1}
            step={0.05}
            onChange={(next) => actions.setWind({ gustiness: next })}
          />
          <Slider
            label="Terrain roughness"
            value={wind.roughness}
            min={0}
            max={1}
            step={0.05}
            onChange={(next) => actions.setWind({ roughness: next })}
          />
        </Card>

        <Card title="Time of day">
          <Slider
            label="Local time"
            value={timeOfDay}
            min={0}
            max={24}
            step={0.05}
            decimals={2}
            onChange={actions.setTimeOfDay}
          />
          <div className="switch-desc">
            Sun position is real astronomy for the map's latitude, so a low winter
            sun really does produce long shadows and a cold pack.
          </div>
          <div className="stat-grid" style={{ marginTop: 8 }}>
            <Stat
              label="Sun elevation"
              value={`${(((snapshot?.weather.sun.elevationRad ?? 0) * 180) / Math.PI).toFixed(1)}°`}
            />
            <Stat
              label="Visibility"
              value={`${((snapshot?.weather.visibilityM ?? 0) / 1000).toFixed(1)} km`}
            />
            <Stat
              label="Air density"
              value={`${(snapshot?.weather.airDensity ?? 0).toFixed(3)} kg/m³`}
            />
          </div>
        </Card>

        <Card title="World">
          <div className="field">
            <label className="label" htmlFor="seed">
              Terrain seed
            </label>
            <span />
            <input id="seed" type="text" value={seed} onChange={(e) => actions.setSeed(e.target.value)} />
          </div>
          <div className="switch-desc">
            The same seed always regenerates the same terrain, obstacles and pilot
            stand points. Change it and the map is rebuilt.
          </div>
        </Card>
      </div>
    </div>
  );
}
