import { useMemo } from 'react';
import {
  PID_RANGES,
  RATE_RANGES,
  TUNE_PRESETS,
  analyseTune,
  type TuneAxis,
} from '../../core/tuning/tuner';
import { actions, useStore } from '../../state/store';
import { Bar, Card, PanelHead, Slider, Stat } from '../components';

const AXES: { axis: TuneAxis; label: string }[] = [
  { axis: 'roll', label: 'Roll' },
  { axis: 'pitch', label: 'Pitch' },
  { axis: 'yaw', label: 'Yaw' },
];

const TERMS = [
  { key: 'p' as const, label: 'P — how hard it corrects error' },
  { key: 'i' as const, label: 'I — kills steady drift' },
  { key: 'd' as const, label: 'D — damps the response' },
  { key: 'f' as const, label: 'F — how snappy it feels' },
];

export function TunerPanel(): JSX.Element {
  const tune = useStore((s) => s.tune);
  const presetId = useStore((s) => s.tunePresetId);

  const warnings = useMemo(() => (tune ? analyseTune(tune) : []), [tune]);

  if (!tune) return <div className="panel">Loading tuner…</div>;

  return (
    <div className="panel wide">
      <PanelHead title="Tuner">
        <span className="label">Preset</span>
        <select value={presetId} onChange={(e) => actions.setTunePreset(e.target.value)} style={{ maxWidth: 220 }}>
          {TUNE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </PanelHead>

      <div className="grid">
        {AXES.map(({ axis, label }) => (
          <Card key={axis} title={`${label} PID`}>
            {TERMS.map((term) => {
              const [min, max, step] = PID_RANGES[axis][term.key];
              return (
                <Slider
                  key={term.key}
                  label={term.label}
                  value={tune.pid[axis][term.key]}
                  min={min}
                  max={max}
                  step={step}
                  decimals={1}
                  onChange={(next) => actions.setPid(axis, term.key, next)}
                />
              );
            })}
            <div className="label" style={{ marginTop: 6 }}>
              Authority: {tune[`${axis}Authority`].toFixed(2)}×
            </div>
            <Bar value={tune[`${axis}Authority`]} />
          </Card>
        ))}

        {AXES.map(({ axis, label }) => (
          <Card key={`${axis}-rates`} title={`${label} rates`}>
            <Slider
              label="Centre sensitivity — deg/s"
              value={tune.rates[axis].center}
              min={RATE_RANGES[axis].center[0]}
              max={RATE_RANGES[axis].center[1]}
              step={RATE_RANGES[axis].center[2]}
              decimals={0}
              onChange={(next) => actions.setRate(axis, 'center', next)}
            />
            <Slider
              label="Maximum rate — deg/s"
              value={tune.rates[axis].max}
              min={RATE_RANGES[axis].max[0]}
              max={RATE_RANGES[axis].max[1]}
              step={RATE_RANGES[axis].max[2]}
              decimals={0}
              onChange={(next) => actions.setRate(axis, 'max', next)}
            />
            <Slider
              label="Expo — 0 linear, 1 smoothed"
              value={tune.rates[axis].expo}
              min={RATE_RANGES[axis].expo[0]}
              max={RATE_RANGES[axis].expo[1]}
              step={RATE_RANGES[axis].expo[2]}
              decimals={2}
              onChange={(next) => actions.setRate(axis, 'expo', next)}
            />
          </Card>
        ))}

        <Card title="Filters">
          <Slider
            label="Gyro low-pass — Hz"
            value={tune.filters.gyroLowpassHz}
            min={50}
            max={200}
            step={1}
            decimals={0}
            unit=" Hz"
            onChange={(next) => actions.setFilter('gyroLowpassHz', next)}
          />
          <Slider
            label="D-term low-pass — Hz"
            value={tune.filters.dtermLowpassHz}
            min={40}
            max={180}
            step={1}
            decimals={0}
            unit=" Hz"
            onChange={(next) => actions.setFilter('dtermLowpassHz', next)}
          />
          <Slider
            label="Notch centre — Hz"
            value={tune.filters.notchHz}
            min={80}
            max={360}
            step={1}
            decimals={0}
            unit=" Hz"
            onChange={(next) => actions.setFilter('notchHz', next)}
          />
          <Slider
            label="Notch Q"
            value={tune.filters.notchQ}
            min={1}
            max={6}
            step={0.1}
            onChange={(next) => actions.setFilter('notchQ', next)}
          />
          <div className="stat-grid" style={{ marginTop: 8 }}>
            <Stat label="Frame resonance" value={`${tune.frameResonanceHz.toFixed(0)} Hz`} />
            <Stat
              label="Notch offset"
              value={`${Math.abs(tune.filters.notchHz - tune.frameResonanceHz).toFixed(0)} Hz`}
              tone={Math.abs(tune.filters.notchHz - tune.frameResonanceHz) < tune.frameResonanceHz * 0.2 ? 'good' : 'warn'}
            />
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 10 }}>
        {warnings.length === 0 ? (
          <div className="issue" data-level="info">
            <span>✓</span>
            <span>No problems found in this tune.</span>
          </div>
        ) : (
          warnings.map((warning, index) => (
            <div key={index} className="issue" data-level={warning.level === 'error' ? 'error' : warning.level}>
              <span aria-hidden>{warning.level === 'error' ? '✕' : warning.level === 'warning' ? '!' : 'i'}</span>
              <span>{warning.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
