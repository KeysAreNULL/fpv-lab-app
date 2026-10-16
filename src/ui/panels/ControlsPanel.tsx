import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTROL_SURFACES,
  SURFACE_LABELS,
  type Binding,
  type ControlSurface,
} from '../../input/types';
import { STICK_MODE_LABELS, type StickAxis } from '../../input/mapping';
import { CH_CENTRE, RadioDriver } from '../../input/radio';
import { isTransmitter } from '../../input/gamepad';
import { actions, useStore } from '../../state/store';
import { Card, PanelHead, Select, Stat, Switch } from '../components';

const AXES: StickAxis[] = ['roll', 'pitch', 'yaw', 'throttle'];

/** How many channels the raw monitor shows. */
const CHANNEL_MONITOR_COUNT = 12;

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
  const [channels, setChannels] = useState<number[]>([]);
  const [pads, setPads] = useState<{ id: string; transmitter: boolean; axes: number[] }[]>([]);
  // Separate handles per effect. Sharing one ref meant each effect's cleanup
  // cancelled the *other* effect's pending frame, so finishing a rebind killed
  // the live readout loop and the panel froze — reading as "rebinding broke".
  const listenRaf = useRef(0);
  const liveRaf = useRef(0);

  const settings = input?.settings;

  /**
   * While "listen" is on, poll the raw device and record which control moved
   * most from where it started. A short settle delay stops a drifting gimbal
   * from capturing the wrong thing.
   *
   * A controller is checked first, then the radio's channels, so a transmitter
   * is rebound exactly the way a gamepad is.
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
        listenRaf.current = requestAnimationFrame(tick);
        return;
      }

      // No controller: capture from the transmitter instead. Thresholds are in
      // microseconds, so a switch throw counts the same as a stick sweep.
      const live = input.radio.channels;
      if (live.length >= 4) {
        const values = [...live];
        if (baseline === null) baseline = values;
        let bestIndex = -1;
        let bestDelta = 120;
        values.forEach((value, index) => {
          const delta = Math.abs(value - (baseline?.[index] ?? CH_CENTRE));
          if (delta > bestDelta) {
            bestDelta = delta;
            bestIndex = index;
          }
        });
        if (bestIndex >= 0) {
          actions.assignBinding(listening, { kind: 'channel', id: bestIndex });
          setListening(null);
          return;
        }
        if (++settled > 20) baseline = values;
      }
      listenRaf.current = requestAnimationFrame(tick);
    };
    listenRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(listenRaf.current);
  }, [listening, input]);

  /** Live values for the readout, polled at the UI rate only. */
  useEffect(() => {
    let last = performance.now();
    let channelTick = 0;
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
      // Raw channel monitor, deliberately slower than the readout: this is a
      // diagnostic, and a pilot needs to see which channel is moving to tell a
      // dead link from a wrong channel order.
      if (now - channelTick > 100) {
        channelTick = now;
        setChannels([...(input?.radio.channels ?? [])].slice(0, CHANNEL_MONITOR_COUNT));
        // A radio in USB Joystick mode enumerates as a HID joystick and shows
        // up here rather than as a serial port, so list what the browser can
        // actually see.
        setPads(
          (navigator.getGamepads?.() ?? [])
            .filter((p): p is Gamepad => p !== null)
            .map((p) => ({ id: p.id, transmitter: isTransmitter(p.id), axes: Array.from(p.axes) })),
        );
      }
      liveRaf.current = requestAnimationFrame(tick);
    };
    liveRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(liveRaf.current);
  }, [input]);

  const readValue = useCallback((surface: ControlSurface): number => live[surface] ?? 0, [live]);
  const calibration = settings?.calibration;

  /** "CH3 Throttle" for a radio binding, "axis 2" for a controller one. */
  const describeBinding = useCallback(
    (binding: Binding | undefined): string => {
      if (!binding) return 'default — press Listen and move the control';
      if (binding.kind === 'channel') return input?.radio.channelLabel(Number(binding.id)) ?? '—';
      return `${binding.kind} ${binding.id}`;
    },
    [input],
  );

  const boundCount = Object.keys(bindings).length;

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
        <div className="row" style={{ marginBottom: 8, justifyContent: 'space-between' }}>
          <span className="switch-desc">
            Listen captures from{' '}
            {device.kind === 'radio' ? 'the transmitter' : `the ${device.kind}`}. Bound
            channels override stick mode for that surface only.
          </span>
          <button className="btn small" disabled={boundCount === 0} onClick={actions.resetBindings}>
            Reset all
          </button>
        </div>
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
                  {binding ? (
                    <button
                      className="btn small"
                      style={{ minHeight: 30 }}
                      aria-label={`Clear binding for ${SURFACE_LABELS[surface]}`}
                      onClick={() => actions.clearBinding(surface)}
                    >
                      Clear
                    </button>
                  ) : null}
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
                  {describeBinding(binding)}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Radio link">
        <div className="switch-desc" style={{ marginBottom: 6 }}>
          A transmitter in USB <strong>Joystick</strong> mode is not a serial
          port — the browser sees it as a controller below, and no "Connect" is
          needed. <strong>Serial</strong> mode uses the Connect button instead.
        </div>
        <div className="stat-grid" style={{ marginBottom: 8 }}>
          <Stat label="Controllers seen" value={String(pads.length)} tone={pads.length ? 'good' : 'warn'} />
        </div>
        {pads.length === 0 ? (
          <span className="part-meta">
            No controllers detected — the transmitter is not enumerating, or the
            browser is holding it.
          </span>
        ) : (
          pads.map((pad) => (
            <div key={pad.id} style={{ marginBottom: 8 }}>
              <div className="part-name">{pad.id}</div>
              <span className="part-meta">
                {pad.transmitter
                  ? 'Detected as a transmitter. Move one gimbal at a time and check which axis moves — then Listen on that surface to bind it.'
                  : 'Detected as a generic controller.'}
              </span>
              <div className="stat-grid" style={{ marginTop: 4 }}>
                {pad.axes.map((value, index) => (
                  <Stat
                    key={index}
                    label={`Axis ${index}`}
                    value={value.toFixed(2)}
                    tone={Math.abs(value) > 0.15 ? 'good' : undefined}
                  />
                ))}
              </div>
            </div>
          ))
        )}
        {channels.length === 0 ? (
          <span className="part-meta">No serial channel data.</span>
        ) : (
          <div className="stat-grid">
            {channels.map((value, index) => (
              <Stat
                key={index}
                label={input?.radio.channelLabel(index) ?? `CH${index + 1}`}
                value={`${Math.round(value)}`}
                tone={
                  Math.abs(value - CH_CENTRE) < 15
                    ? undefined
                    : value > CH_CENTRE
                      ? 'good'
                      : 'warn'
                }
              />
            ))}
          </div>
        )}
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
