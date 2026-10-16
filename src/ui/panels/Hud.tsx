import { useStore } from '../../state/store';
import { fmtDuration, fmtSpeed } from '../components';
import type { WorldSnapshot } from '../../core/sim/world';

const LINK_COLOUR = {
  strong: 'hud-good',
  ok: 'hud-good',
  weak: 'hud-warn',
  critical: 'hud-warn',
  failsafe: 'hud-bad',
} as const;

const VIDEO_COLOUR = {
  clean: 'hud-good',
  degraded: 'hud-warn',
  snow: 'hud-warn',
  lost: 'hud-bad',
} as const;

/** Four-bar signal meter. */
function Bars({ quality }: { quality: number }): JSX.Element {
  const filled = Math.round(quality * 4);
  return (
    <span className="signal-bars" style={{ color: 'currentColor' }}>
      {[1, 2, 3, 4].map((level) => (
        <span
          key={level}
          style={{ height: `${level * 3}px`, opacity: level <= filled ? 1 : 0.22 }}
        />
      ))}
    </span>
  );
}

/**
 * The pilot's HUD. Deliberately modelled on a real FPV OSD rather than a game
 * HUD: speed and altitude are big, everything else is small, and the warning
 * lights are where a pilot's eye goes first.
 */
export function Hud({ snapshot }: { snapshot: WorldSnapshot }): JSX.Element {
  const battery = snapshot.battery;
  const cellTone = battery.cellVoltage < 3.5 ? 'hud-bad' : battery.cellVoltage < 3.7 ? 'hud-warn' : '';
  const crashtone = snapshot.damage.overall < 0.5 ? 'hud-warn' : snapshot.damage.overall < 0.85 ? '' : 'hud-good';

  return (
    <div className="hud">
      {/* --- Speed and altitude, top left --- */}
      <div className="hud-corner hud-tl">
        <div className="hud-big">{fmtSpeed(snapshot.speed)}</div>
        <div className="hud-dim">
          {snapshot.heightAgl.toFixed(1)} m AGL · {snapshot.altitudeMsl.toFixed(0)} m MSL
        </div>
        <div className={crashtone}>
          {snapshot.flightTime > 0 ? `Air ${fmtDuration(snapshot.flightTime)}` : 'Disarmed'}
        </div>
      </div>

      {/* --- Links and battery, top right --- */}
      <div className="hud-corner hud-tr">
        <span className={LINK_COLOUR[snapshot.signal.control.state]}>
          <Bars quality={snapshot.signal.control.lq / 100} /> LQ {snapshot.signal.control.lq.toFixed(0)}%
        </span>
        <span className={VIDEO_COLOUR[snapshot.signal.video.state]}>
          <Bars quality={snapshot.signal.video.quality} />{' '}
          {snapshot.signal.video.state === 'lost' ? 'NO VIDEO' : snapshot.signal.video.state.toUpperCase()}
        </span>
        <span className={cellTone}>
          {battery.voltage.toFixed(1)} V · {(battery.cellVoltage).toFixed(2)} V/cell
        </span>
        <span className={battery.currentAmps > 90 ? 'hud-warn' : 'hud-dim'}>
          {battery.currentAmps.toFixed(0)} A · {battery.soc * 100 > 0 ? `${(battery.soc * 100).toFixed(0)}%` : '0%'}
          {Number.isFinite(battery.remainingSeconds) ? ` · ${fmtDuration(battery.remainingSeconds)}` : ''}
        </span>
      </div>

      {/* --- Attitude indicator --- */}
      <div className="horizon">
        <div
          className="horizon-inner"
          style={{ transform: `translateY(${snapshot.attitudeDeg.roll * 0.9}px) rotate(${-snapshot.attitudeDeg.pitch * 0.9}px)` }}
        >
          <div className="horizon-sky" />
          <div className="horizon-ground" />
          <div className="horizon-line" />
        </div>
        <div className="horizon-reticle" />
      </div>

      {/* --- Bottom left: throttle, thrust, distance --- */}
      <div className="hud-corner hud-bl">
        <div>THR {(snapshot.motorThrottle[0] * 100).toFixed(0)}%</div>
        <div className="hud-dim">
          {snapshot.thrustN.toFixed(1)} N · T/W {snapshot.thrustToWeight.toFixed(2)}
        </div>
        <div className="hud-dim">
          {snapshot.motorRpm.map((rpm) => `${(rpm / 1000).toFixed(1)}k`).join(' ')}
        </div>
        <div className="hud-dim">{snapshot.distanceFlownM.toFixed(0)} m flown</div>
      </div>

      {/* --- Bottom right: wind, environment, damage --- */}
      <div className="hud-corner hud-br">
        <div>
          Wind {snapshot.wind.speed.toFixed(1)} m/s {snapshot.wind.directionDeg.toFixed(0)}°
          {Math.abs(snapshot.wind.updraft) > 0.3 ? (
            <span className={snapshot.wind.updraft > 0 ? 'hud-good' : 'hud-warn'}>
              {' '}
              {snapshot.wind.updraft > 0 ? '↑' : '↓'}
              {Math.abs(snapshot.wind.updraft).toFixed(1)}
            </span>
          ) : null}
        </div>
        <div className="hud-dim">
          {snapshot.weather.clockLabel} · {snapshot.weather.rainMmPerHour > 0.1
            ? `${snapshot.weather.rainMmPerHour.toFixed(1)} mm/h`
            : 'dry'}
        </div>
        {snapshot.damage.overall < 0.995 ? (
          <div className={snapshot.damage.overall < 0.5 ? 'hud-bad' : 'hud-warn'}>{snapshot.damage.worstIssue}</div>
        ) : null}
        {snapshot.contact && snapshot.contact.approachSpeed > 1 ? (
          <div className="hud-bad">HIT {snapshot.contact.surface}</div>
        ) : null}
      </div>

      {/* Analog snow overlay, driven by the video link quality. */}
      {snapshot.signal.video.snow > 0.01 ? (
        <div className="snow-overlay" style={{ ['--snow' as string]: snapshot.signal.video.snow }} />
      ) : null}
    </div>
  );
}

/** Thin wrapper so the HUD can be toggled from the app shell. */
export function HudLayer(): JSX.Element | null {
  const snapshot = useStore((s) => s.snapshot);
  const show = useStore((s) => s.showHud);
  if (!show || !snapshot) return null;
  return <Hud snapshot={snapshot} />;
}
