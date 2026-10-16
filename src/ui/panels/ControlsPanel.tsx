import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTROL_SURFACES, SURFACE_LABELS, type ControlSurface } from '../../input/types';
import { STICK_MODE_LABELS, type StickAxis } from '../../input/mapping';
import { RadioDriver } from '../../input/radio';
import { actions, useStore } from '../../state/store';
import { Card, PanelHead, Select, Stat, Switch } from '../components';

const AXES: StickAxis[] = ['roll', 'pitch', 'yaw', 'throttle'];

const STICK_MODE_OPTIONS = ([1, 2, 3, 4] as const).map((mode) => ({
  value: String(mode) as '1' | '2' | '3' | '4',
  label: STICK_MODE_LABELS[mode],
}));

/**
 * Control mapping.
 *
 * This is the panel that makes the app usable with whatever the pilot actually
 * owns. One row per control surface, the live value from whichever device is
 * active, and rebind / calibrate / reverse for every axis.
 *
 * "Listen" is the important affordance: press it, move the control, and the
 * panel captures whatever moved. That is how every serious tool does it, and it
 * works identically for a gamepad, a radio over serial, or the touch screen.
 */
export function ControlsPanel(): JSX.Element {
  const input = useStore((s) => s.input);
  const device = useStore((s) => s.device);
  const bindings = useStore((s) => s.bindings);
  const [listening, setListening] = useState<ControlSurface | null>(null);
  const [live, setLive] = useState<Record<string, number>>({});
  const rafRef = useRef(0);

  const settings = input?.settings;

  /**
   * While "listen" is on, poll the raw device and record which control moved
   * most from where it started. A short settle delay stops a drifting gimbal
   * from capturing the wrong thing.
   */
  useEffect(() => {
    if (!listening || !input) return undefined;
    let baseline: number[] | null = null;
    let settled = 0;

    const tick = (): void => {
      const pads = navigator.getGamepads?.() ?? [];
      const pad = pads.find((p) => p) ?? null;
      if (pad) {
        const values = [...pad.axes, ...pad.buttons.map((b) => b.value)];
        if (baseline === null) baseline = values;
        let bestIndex = -1;
        let bestDelta = 0.18;
        values.forEach((value, index) => {
          const delta = Math.abs(value - (baseline?.[index] ?? 0));
          if (delta > bestDelta) {
            bestDelta = delta;
            bestIndex = index;
          }
        });
        if (bestIndex >= 0) {
          const isButton = bestIndex >= pad.axes.length;
          actions.assignBinding(
            listening,
            isButton
              ? { kind: 'button', id: bestIndex - pad.axes.length }
              : { kind: 'axis', id: bestIndex },
          );
          setListening(null);
          return;
        }
        if (++settled > 20) baseline = values;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [listening, input]);

  /** Live values for the readout, polled at the UI rate only. */
  useEffect(() => {
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const frame = input?.poll(dt, now / 1000);
      if (frame) {
        setLive(() => ({
          roll: frame.roll,
          pitch: frame.pitch,
          yaw: frame.yaw,
          throttle: frame.throttle,
          ...Object.fromEntries(
            Object.entries(frame.switches).map(([key, on]) => [key, on ? 1 : 0]),
          ),
        }));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [input]);

  const readValue = useCallback((surface: ControlSurface): number => live[surface] ?? 0, [live]);
  const calibration = settings?.calibration;

  return (
    <div className="panel wide">
      <PanelHead title="Controls">
        <button className="btn small" onClick={() => actions.cycleDriver()}>
          Device: {device.id || device.kind}
        </button>
        <button className="btn small primary" onClick={() => void actions.connectRadio()}>
          {RadioDriver.supported ? 'Connect radio (USB)' : 'Web Serial unavailable'}
        </button>
      </PanelHead>

      <div className="grid">
        <Card title="Stick mode">
          <Select
            label="Betaflight stick mode"
            value={String(settings?.stickMode ?? 2) as '1' | '2' | '3' | '4'}
            options={STICK_MODE_OPTIONS}
            onChange={(next) => actions.setStickMode(Number(next) as 1 | 2 | 3 | 4)}
          />
          <div className="switch-desc" style={{ marginTop: 4 }}>
            Stick mode is applied in one place for every device, so a RadioMaster in
            mode 2 and a gamepad in mode 2 behave identically.
          </div>
          <div style={{ marginTop: 10 }}>
            <Switch
              label="Throttle/yaw arming gesture"
              description="Throttle low → yaw left → yaw right. Works on any transmitter."
              checked={settings?.gestureArm ?? true}
              onChange={actions.setGestureArm}
            />
          </div>
        </Card>

        <Card title="Channel calibration">
          {AXES.map((axis) => (
            <div key={axis} style={{ marginBottom: 10 }}>
              <div className="label" style={{ textTransform: 'capitalize', marginBottom: 2 }}>
                {axis}
              </div>
              <RangeRow
                label="Deadband"
                value={calibration?.[axis]?.deadband ?? 0.02}
                min={0}
                max={0.2}
                step={0.005}
                decimals={3}
                onChange={(next) => actions.setCalibration(axis, 'deadband', next)}
              />
              <RangeRow
                label="Smoothing"
                value={calibration?.[axis]?.smoothing ?? 0.02}
                min={0}
                max={0.2}
                step={0.005}
                decimals={3}
                unit=" s"
                onChange={(next) => actions.setCalibration(axis, 'smoothing', next)}
              />
              <Switch
                label="Reverse"
                checked={calibration?.[axis]?.reversed ?? false}
                onChange={(next) => actions.setCalibration(axis, 'reversed', next)}
              />
            </div>
          ))}
        </Card>
      </div>

      <Card title="Control surfaces">
        <div className="part-list" style={{ maxHeight: 'none' }}>
          {CONTROL_SURFACES.map((surface) => {
            const isAxis =
              surface === 'roll' ||
              surface === 'pitch' ||
              surface === 'yaw' ||
              surface === 'throttle';
            const value = readValue(surface);
            const binding = bindings[surface];
            return (
              <div key={surface} className="part" style={{ cursor: 'default' }}>
                <span className="part-name">{SURFACE_LABELS[surface]}</span>
                <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  {isAxis ? (
                    <span className="part-price">{value.toFixed(2)}</span>
                  ) : (
                    <span
                      className="signal-badge"
                      style={{ color: value > 0.5 ? 'var(--good)' : 'var(--text-faint)' }}
                    >
                      {value > 0.5 ? 'ON' : 'off'}
                    </span>
                  )}
                  <button
                    className="btn small"
                    style={{ minHeight: 30 }}
                    aria-pressed={listening === surface}
                    onClick={() => setListening(listening === surface ? null : surface)}
                  >
                    {listening === surface ? 'Move it…' : 'Listen'}
                  </button>
                </span>
                <span className="part-meta">
                  <div className="bar">
                    <i
                      style={{
                        width: `${Math.abs(value) * 100}%`,
                        background: value >= 0 ? 'var(--accent)' : 'var(--analog)',
                      }}
                    />
                  </div>
                  {binding ? `bound: ${binding.kind} ${binding.id}` : 'default — press Listen and move the control'}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="stat-grid" style={{ marginTop: 10 }}>
        <Stat label="Device" value={device.id || '—'} />
        <Stat
          label="Connected"
          value={device.connected ? 'yes' : 'no'}
          tone={device.connected ? 'good' : 'warn'}
        />
        {device.protocol ? <Stat label="Protocol" value={device.protocol} /> : null}
        {device.signalQuality !== undefined ? (
          <Stat label="Link" value={`${device.signalQuality.toFixed(0)}%`} />
        ) : null}
        {device.batteryPercent !== undefined ? (
          <Stat label="Radio battery" value={`${device.batteryPercent.toFixed(0)}%`} />
        ) : null}
      </div>
    </div>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  step,
  decimals,
  unit = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  unit?: string;
  onChange: (next: number) => void;
}): JSX.Element {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <span className="value">
        {value.toFixed(decimals)}
        {unit}
      </span>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
