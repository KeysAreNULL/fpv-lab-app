import { useEffect, useRef } from 'react';
import { actions, useStore } from '../../state/store';
import { Card, PanelHead, Stat } from '../components';
import type { LaunchPoint } from '../../core/terrain/generate';

const AREA_COLOUR = ['#4aa8ff', '#36d17a', '#ffb02e'] as const;

/**
 * Top-down map and pilot-position picker.
 *
 * This is the panel that makes the RF model tangible. Standing somewhere else
 * genuinely changes the physics: the pilot's position sets the link geometry,
 * the obstruction list and the local wind, and the live link readout next to
 * each stand point is computed from the same `linkBudget` the simulation uses.
 */
export function MapPanel(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapshot = useStore((s) => s.snapshot);
  const pilotId = useStore((s) => s.world.pilotLaunchPointId);

  const world = useStore((s) => s.world);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const draw = (): void => {
      const context = canvas.getContext('2d');
      if (!context) return;
      const { size } = world.terrain.config;
      const half = size / 2;
      const px = (x: number): number => ((x + half) / size) * canvas.width;
      const pz = (z: number): number => ((z + half) / size) * canvas.height;

      // Background.
      context.fillStyle = '#0a0f14';
      context.fillRect(0, 0, canvas.width, canvas.height);

      // Terrain relief as a coarse heightmap — 96² samples is plenty for a map.
      const grid = 96;
      const cell = canvas.width / grid;
      for (let j = 0; j < grid; j++) {
        for (let i = 0; i < grid; i++) {
          const x = (i / grid) * size - half;
          const z = (j / grid) * size - half;
          const height = world.terrain.sampleHeight(x, z);
          const normalised = Math.max(0, Math.min(1, (height - 0) / (world.terrain.config.amplitude * 2 + world.terrain.config.baseHeight)));
          const shade = Math.round(22 + normalised * 46);
          context.fillStyle = `rgb(${Math.round(shade * 0.75)},${shade},${Math.round(shade * 1.15)})`;
          context.fillRect(i * cell, j * cell, cell + 1, cell + 1);
        }
      }

      // Designated flying areas.
      world.terrain.areas.forEach((area, index) => {
        context.beginPath();
        context.arc(px(area.center.x), pz(area.center.z), (area.radius / size) * canvas.width, 0, Math.PI * 2);
        context.fillStyle = `${AREA_COLOUR[index % AREA_COLOUR.length]}22`;
        context.fill();
        context.strokeStyle = AREA_COLOUR[index % AREA_COLOUR.length];
        context.lineWidth = 1.5;
        context.stroke();
      });

      // Obstacles.
      for (const obstacle of world.terrain.obstacles) {
        const r = Math.max(1.5, (obstacle.radius / size) * canvas.width);
        context.beginPath();
        context.arc(px(obstacle.position.x), pz(obstacle.position.z), r, 0, Math.PI * 2);
        switch (obstacle.kind) {
          case 'building':
          case 'hangar':
            context.fillStyle = '#8a8f96';
            break;
          case 'pylon':
          case 'tower':
            context.fillStyle = '#c98bff';
            break;
          case 'tree':
            context.fillStyle = '#3f7a4a';
            break;
          case 'gate':
            context.fillStyle = '#ff8a3d';
            break;
          default:
            context.fillStyle = '#6a6f76';
        }
        context.fill();
      }

      // Pilot stand points, coloured by how good the link is from there.
      for (const point of world.terrain.launchPoints) {
        const x = px(point.position.x);
        const z = pz(point.position.z);
        context.beginPath();
        context.arc(x, z, 5, 0, Math.PI * 2);
        context.fillStyle = point.id === pilotId ? '#ffffff' : '#9fd0ff';
        context.fill();
        // View cone.
        context.beginPath();
        context.moveTo(x, z);
        const range = 26;
        const halfCone = 0.34;
        context.arc(x, z, range, -point.headingRad - halfCone - Math.PI / 2, -point.headingRad + halfCone - Math.PI / 2);
        context.closePath();
        context.fillStyle = point.hasObstruction ? 'rgba(255,92,92,0.18)' : 'rgba(74,168,255,0.16)';
        context.fill();
      }

      // The drone, with a track tail.
      if (snapshot) {
        const x = px(snapshot.position.x);
        const z = pz(snapshot.position.z);
        context.beginPath();
        context.arc(x, z, 4.5, 0, Math.PI * 2);
        context.fillStyle = snapshot.signal.video.state === 'lost' ? '#ff5c5c' : '#36d17a';
        context.fill();
        context.strokeStyle = 'rgba(0,0,0,0.7)';
        context.lineWidth = 1;
        context.stroke();
      }
    };
    draw();
    const id = setInterval(draw, 250);
    return () => clearInterval(id);
  }, [world, snapshot, pilotId]);

  const stands = world.terrain.launchPoints;
  const current = stands.find((p) => p.id === pilotId);

  return (
    <div className="panel wide">
      <PanelHead title="Map & pilot position">
        <span className="label">Seed: {world.terrain.config.seed}</span>
      </PanelHead>

      <div className="grid">
        <Card title="Overview">
          <div className="map-wrap">
            <canvas ref={canvasRef} width={320} height={320} style={{ aspectRatio: '1 / 1' }} />
          </div>
          <div className="map-legend">
            <span>
              <i style={{ background: AREA_COLOUR[0] }} />
              flying area
            </span>
            <span>
              <i style={{ background: '#8a8f96' }} />
              buildings
            </span>
            <span>
              <i style={{ background: '#c98bff' }} />
              pylons
            </span>
            <span>
              <i style={{ background: '#3f7a4a' }} />
              trees
            </span>
            <span>
              <i style={{ background: '#fff' }} />
              your stand
            </span>
          </div>
        </Card>

        <Card title="Where are you standing?">
          <div className="switch-desc" style={{ marginBottom: 8 }}>
            Your position sets the RF geometry, the obstruction list and the local
            wind. The red cone marks a stand point with something in the way.
          </div>
          <div className="part-list">
            {stands.map((point) => (
              <button
                key={point.id}
                className="part"
                data-selected={point.id === pilotId}
                onClick={() => actions.setPilotPosition(point.id)}
              >
                <span className="part-name">{point.name}</span>
                <span className="part-price">{Math.round(point.maxRangeM)} m</span>
                <span className="part-meta">
                  {point.hasObstruction ? '⚠ obstructed view' : 'clear view'} ·{' '}
                  {Math.round(point.position.x)}, {Math.round(point.position.z)}
                </span>
              </button>
            ))}
          </div>
        </Card>

        {snapshot ? (
          <Card title="Live link from here">
            <div className="stat-grid">
              <Stat
                label="Control"
                value={snapshot.signal.control.state}
                tone={
                  snapshot.signal.control.state === 'strong'
                    ? 'good'
                    : snapshot.signal.control.state === 'failsafe'
                      ? 'bad'
                      : 'warn'
                }
              />
              <Stat label="LQ" value={`${snapshot.signal.control.lq.toFixed(0)}%`} />
              <Stat label="RSSI" value={`${snapshot.signal.control.rssiDbm.toFixed(0)} dBm`} />
              <Stat
                label="Video"
                value={snapshot.signal.video.state}
                tone={snapshot.signal.video.state === 'clean' ? 'good' : snapshot.signal.video.state === 'lost' ? 'bad' : 'warn'}
              />
              <Stat label="Path loss" value={`${snapshot.signal.control.budget.pathLossDb.toFixed(0)} dB`} />
              <Stat label="Penetration" value={`${snapshot.signal.control.budget.penetrationLossDb.toFixed(1)} dB`} />
              <Stat label="Fresnel" value={`${snapshot.signal.control.budget.fresnelLossDb.toFixed(1)} dB`} />
              <Stat label="Margin" value={`${snapshot.signal.control.budget.marginDb.toFixed(1)} dB`} />
              <Stat label="Distance" value={`${snapshot.signal.control.budget.distanceM.toFixed(0)} m`} />
            </div>
            {current ? (
              <div className="switch-desc" style={{ marginTop: 8 }}>
                Standing at {current.name}, facing{' '}
                {((current.headingRad * 180) / Math.PI + 360) % 360 > 180
                  ? (((current.headingRad * 180) / Math.PI + 360) % 360) - 360
                  : ((current.headingRad * 180) / Math.PI + 360) % 360}
                °
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </div>
  );
}

export type { LaunchPoint };
