import type { ReactNode } from 'react';
import { useCallback, useId } from 'react';

/** Small presentational primitives shared by every panel. */

export function PanelHead({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="panel-head">
      <span className="panel-title">{title}</span>
      <div className="row">{children}</div>
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="card">
      {title ? <h3>{title}</h3> : null}
      {children}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }): JSX.Element {
  const className = tone ? `stat-value hud-${tone}` : 'stat-value';
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={className}>{value}</div>
    </div>
  );
}

export interface SwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function Switch({ label, description, checked, onChange, disabled }: SwitchProps): JSX.Element {
  return (
    <button
      type="button"
      className="switch"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      disabled={disabled}
      style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left' }}
    >
      <span>
        <span style={{ display: 'block' }}>{label}</span>
        {description ? <span className="switch-desc">{description}</span> : null}
      </span>
      <span className="switch-track" data-on={checked}>
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  decimals = 2,
  disabled,
  onChange,
}: SliderProps): JSX.Element {
  const id = useId();
  const handle = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value)),
    [onChange],
  );
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <span className="value">
        {value.toFixed(decimals)}
        {unit}
      </span>
      <input
        id={id}
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={handle}
      />
    </div>
  );
}

export function Bar({ value, tone }: { value: number; tone?: 'good' | 'warn' | 'bad' }): JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const color = tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : tone === 'good' ? 'var(--good)' : 'var(--accent)';
  return (
    <div className="bar">
      <i style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <span />
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Format a number with a fixed number of decimals and an optional unit. */
export const fmt = (value: number, decimals = 1, unit = ''): string =>
  `${value.toFixed(decimals)}${unit}`;

/** Format seconds as m:ss. */
export const fmtDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '∞';
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Metres, rendered in whatever unit keeps it readable. */
export const fmtDistance = (metres: number): string =>
  metres < 1000 ? `${metres.toFixed(1)} m` : `${(metres / 1000).toFixed(2)} km`;

/** m/s rendered as km/h, which is how every FPV OSD shows it. */
export const fmtSpeed = (metersPerSecond: number): string =>
  `${(metersPerSecond * 3.6).toFixed(0)} km/h`;
