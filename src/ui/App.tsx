import { useEffect, useRef } from 'react';
import { actions, startLoop, stopLoop, useStore, type PanelId } from '../state/store';
import { HudLayer } from './panels/Hud';
import { VirtualGimbals } from './panels/VirtualGimbals';
import { BuilderPanel } from './panels/BuilderPanel';
import { TunerPanel } from './panels/TunerPanel';
import { ControlsPanel } from './panels/ControlsPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { MapPanel } from './panels/MapPanel';
import { InputManager } from '../input/manager';

const TABS: { id: PanelId; label: string }[] = [
  { id: 'fly', label: 'Fly' },
  { id: 'builder', label: 'Builder' },
  { id: 'tuner', label: 'Tuner' },
  { id: 'controls', label: 'Controls' },
  { id: 'map', label: 'Map' },
  { id: 'settings', label: 'Settings' },
];

export function App(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panel = useStore((s) => s.panel);
  const cameraMode = useStore((s) => s.cameraMode);
  const snapshot = useStore((s) => s.snapshot);
  const toast = useStore((s) => s.toast);
  const paused = useStore((s) => s.paused);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    // Starting input needs a user gesture on some browsers, so the touch driver
    // is always live and the manager upgrades when a pad or radio appears.
    const input = new InputManager();
    useStore.setState({ input });
    void input.start('gamepad');
    startLoop(canvas, input);
    return () => stopLoop();
  }, []);

  const flying = snapshot?.phase === 'flying' || snapshot?.phase === 'armed';

  return (
    <div className="app">
      <div className="viewport">
        <canvas ref={canvasRef} />

        <HudLayer />
        <VirtualGimbals />

        {/* Always-visible flight controls, even when another panel is open. */}
        <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6 }}>
          <button
            className="btn small"
            aria-pressed={cameraMode === 'fpv'}
            onClick={() => actions.setCameraMode('fpv')}
          >
            FPV
          </button>
          <button
            className="btn small"
            aria-pressed={cameraMode === 'chase'}
            onClick={() => actions.setCameraMode('chase')}
          >
            Chase
          </button>
        </div>

        {toast ? (
          <div className="toast" data-tone={toast.tone}>
            {toast.text}
          </div>
        ) : null}
      </div>

      <div className="topbar">
        <span className="brand">FPV LAB</span>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className="tab"
            role="tab"
            aria-selected={panel === tab.id}
            onClick={() => actions.setPanel(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          className={`btn small ${flying ? 'danger' : 'primary'}`}
          onClick={() => actions.toggleArm()}
        >
          {flying ? 'Disarm' : 'Arm'}
        </button>
        <button className="btn small" onClick={() => actions.reset()}>
          Reset
        </button>
        <button className="btn small" onClick={() => actions.togglePause()}>
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {panel === 'fly' ? <FlyPanel /> : null}
      {panel === 'builder' ? <BuilderPanel /> : null}
      {panel === 'tuner' ? <TunerPanel /> : null}
      {panel === 'controls' ? <ControlsPanel /> : null}
      {panel === 'map' ? <MapPanel /> : null}
      {panel === 'settings' ? <SettingsPanel /> : null}
    </div>
  );
}

/** The default panel: a compact flight summary with the key warnings. */
function FlyPanel(): JSX.Element | null {
  const snapshot = useStore((s) => s.snapshot);
  const settings = useStore((s) => s.settings);
  const tune = useStore((s) => s.tune);
  if (!snapshot) return null;

  const warnings: string[] = [];
  if (!snapshot.armed) warnings.push('Disarmed — flick the arm switch or the ARM button.');
  if (snapshot.signal.control.state === 'critical') warnings.push('Control link is critical. Move or point the pilot somewhere with line of sight.');
  if (snapshot.signal.video.state === 'lost') warnings.push('Video lost. Check the VTX band, the antenna and where you are standing.');
  if (snapshot.battery.brownout) warnings.push('Battery below cutoff. Land now.');
  if (snapshot.battery.cellVoltage < 3.5) warnings.push(`Pack is at ${snapshot.battery.cellVoltage.toFixed(2)} V/cell.`);
  if (snapshot.damage.unflyable) warnings.push('Airframe is too damaged to fly safely.');
  else if (snapshot.damage.overall < 0.6) warnings.push(snapshot.damage.worstIssue);

  return (
    <div className="panel">
      <div className="stat-grid">
        <Stat label="Speed" value={`${(snapshot.speed * 3.6).toFixed(0)} km/h`} />
        <Stat label="Altitude" value={`${snapshot.heightAgl.toFixed(1)} m`} />
        <Stat label="Pack" value={`${snapshot.battery.voltage.toFixed(1)} V`} />
        <Stat label="Current" value={`${snapshot.battery.currentAmps.toFixed(0)} A`} />
        <Stat label="LQ" value={`${snapshot.signal.control.lq.toFixed(0)}%`} />
        <Stat label="Wind" value={`${snapshot.wind.speed.toFixed(1)} m/s`} />
        <Stat label="Systems on" value={`${Object.values(settings).filter(Boolean).length}`} />
        <Stat label="Resonance" value={tune ? `${tune.frameResonanceHz.toFixed(0)} Hz` : '—'} />
      </div>

      {warnings.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          {warnings.map((warning, index) => (
            <div key={index} className="issue" data-level="warning">
              <span aria-hidden>!</span>
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="switch-desc" style={{ marginTop: 10 }}>
        <b>Keyboard (virtual transmitter):</b> <b>Shift</b> raises the throttle,{' '}
        <b>Ctrl</b> lowers it, and it holds where you leave it — like a real lever.
        <b>W/S</b> pitch, <b>A/D</b> roll, <b>Q/E</b> yaw, <b>Space</b> arm/disarm,{' '}
        <b>B</b> buzzer, <b>R</b> record.
        <br />
        On a phone, use the on-screen gimbals. On a desktop, plug in any gamepad or a
        transmitter&apos;s USB dongle.
      </div>
    </div>
  );
}

import { Stat } from './components';
