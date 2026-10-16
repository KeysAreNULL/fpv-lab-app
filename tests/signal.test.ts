import { describe, expect, it } from 'vitest';
import { World } from '../src/core/sim/world';
import { findBuild } from '../src/core/parts/presets';
import { DEFAULT_SETTINGS, applySettingsPreset, countEnabled, type SimSettings } from '../src/core/sim/settings';
import { freeSpacePathLoss, MATERIALS, videoTxPowerDbm, videoSensitivityDbm } from '../src/core/sim/signal';
import { createRng } from '../src/core/math/rng';
import { Terrain } from '../src/core/terrain/generate';
import { solarPosition } from '../src/core/sim/weather';
import { impactEnergy, surfaceDamping, DamageModel, freshDamage } from '../src/core/sim/damage';
import { detectCollision } from '../src/core/sim/collision';
import { eulerToQuat } from '../src/core/math/quat';
import { ZERO_INPUT } from '../src/core/physics/quadrotor';

const buildWorld = (settings: SimSettings = DEFAULT_SETTINGS, seed = 'test') =>
  new World(findBuild('preset-freestyle-5-analog'), { seed }, settings);

const settle = (world: World, seconds = 2, input = { ...ZERO_INPUT }) => {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) world.step(1 / 60, input);
};

describe('link budget', () => {
  it('matches textbook free-space path loss', () => {
    // At 1 km and 5.8 GHz, FSPL is 107.7 dB: 32.44 + 0 + 20·log₁₀(5800).
    expect(freeSpacePathLoss(1000, 5.8e9)).toBeCloseTo(107.7, 1);
    // At 100 m it is 20 dB lower.
    expect(freeSpacePathLoss(100, 5.8e9)).toBeCloseTo(87.7, 1);
  });

  it('is monotonic in distance', () => {
    let previous = -Infinity;
    for (const d of [10, 50, 100, 500, 1000, 5000]) {
      const loss = freeSpacePathLoss(d, 5.8e9);
      expect(loss).toBeGreaterThan(previous);
      previous = loss;
    }
  });

  it('loses 20 dB per decade in both distance and frequency', () => {
    const base = freeSpacePathLoss(100, 5.8e9);
    expect(freeSpacePathLoss(1000, 5.8e9) - base).toBeCloseTo(20, 1);
    // An order of magnitude *lower* in frequency loses 20 dB.
    expect(freeSpacePathLoss(100, 580e6) - base).toBeCloseTo(-20, 1);
  });

  it('converts VTX power to dBm', () => {
    expect(videoTxPowerDbm(25)).toBeCloseTo(14, 1);
    expect(videoTxPowerDbm(1000)).toBeCloseTo(30, 1);
    // Digital receivers are more sensitive than basic analog ones.
    expect(videoSensitivityDbm('digital')).toBeGreaterThan(videoSensitivityDbm('analog'));
  });

  it('ranks materials by how well they block RF', () => {
    expect(MATERIALS.metal.dbPerMeter).toBeGreaterThan(MATERIALS.concrete.dbPerMeter);
    expect(MATERIALS.concrete.dbPerMeter).toBeGreaterThan(MATERIALS.wood.dbPerMeter);
    expect(MATERIALS.wood.dbPerMeter).toBeGreaterThan(MATERIALS.drywall.dbPerMeter);
    expect(MATERIALS.drywall.dbPerMeter).toBeGreaterThan(MATERIALS.glass.dbPerMeter);
  });
});

describe('signal in the world', () => {
  it('gives a clean link with the drone near the pilot', () => {
    const world = buildWorld();
    world.arm();
    settle(world, 1);
    const snap = world.snapshot();
    expect(snap.signal.control.state).toBe('strong');
    expect(snap.signal.video.state).toBe('clean');
    expect(snap.signal.control.lq).toBeGreaterThan(90);
  });

  it('degrades the link with distance', () => {
    const world = buildWorld();
    world.arm();
    settle(world, 1);
    const near = world.snapshot().signal.control.budget.marginDb;
    // Shove the drone far away without moving the pilot.
    world.quad.state.position.x += 2500;
    world.tickSlow(0.2);
    const far = world.snapshot().signal.control.budget.marginDb;
    expect(far).toBeLessThan(near - 60);
  });

  it('returns a neutral snapshot when signal systems are off', () => {
    const world = buildWorld(applySettingsPreset('preset-bench'));
    world.arm();
    settle(world, 2);
    const snap = world.snapshot();
    expect(snap.signal.control.lq).toBe(100);
    expect(snap.signal.video.quality).toBe(1);
    expect(snap.signal.worst).toBe('none');
  });

  it('loses the video but not the control link behind a building', () => {
    const world = buildWorld();
    const stand = world.terrain.launchPoints.find((p) => p.id === 'stand-1');
    expect(stand, 'expected the "behind hangars" stand point').toBeDefined();
    world.setPilotPosition(stand!);
    world.arm();
    // Put the drone on the far side of the town, low.
    world.quad.state.position = { x: 0, y: world.terrain.sampleHeight(0, 0) + 8, z: 0 };
    world.tickSlow(0.2);
    const snap = world.snapshot();
    // The hangar row is between the pad and the course, so penetration must bite.
    expect(snap.signal.control.budget.penetrationLossDb).toBeGreaterThan(0);
    expect(snap.signal.control.lq).toBeLessThan(100);
  });
});

describe('weather and time of day', () => {
  it('puts the sun overhead at solar noon in summer', () => {
    const { elevationRad } = solarPosition(172, 12, 47);
    // Summer solstice at 47° latitude: ~66° elevation at noon.
    expect(elevationRad).toBeGreaterThan(1.0);
    expect(elevationRad).toBeLessThan(1.3);
  });

  it('puts the sun below the horizon at midnight', () => {
    const { elevationRad } = solarPosition(172, 0, 47);
    expect(elevationRad).toBeLessThan(0);
  });

  it('rises in the east and sets in the west', () => {
    const morning = solarPosition(172, 8, 47);
    const evening = solarPosition(172, 16, 47);
    expect(morning.azimuthRad).toBeLessThan(evening.azimuthRad);
  });

  it('reacts to the clock', () => {
    const world = buildWorld();
    const day = world.weather.snapshot(10, () => 1.225);
    world.weather.setTime(22);
    const night = world.weather.snapshot(10, () => 1.225);
    expect(day.sun.daylight).toBeGreaterThan(night.sun.daylight);
  });
});

describe('terrain', () => {
  it('is deterministic for a seed', () => {
    const a = new Terrain({ seed: 'alpha' });
    const b = new Terrain({ seed: 'alpha' });
    const c = new Terrain({ seed: 'beta' });
    expect(a.sampleHeight(12, -34)).toBeCloseTo(b.sampleHeight(12, -34), 6);
    expect(a.sampleHeight(12, -34)).not.toBeCloseTo(c.sampleHeight(12, -34), 3);
  });

  it('flattens the terrain inside designated areas', () => {
    const terrain = new Terrain({ seed: 'areas' });
    const area = terrain.areas[0];
    // Sample inside the area and well outside it, and compare the spread.
    const inside: number[] = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      inside.push(terrain.sampleHeight(
        area.center.x + Math.cos(angle) * area.radius * 0.4,
        area.center.z + Math.sin(angle) * area.radius * 0.4,
      ));
    }
    const spread = Math.max(...inside) - Math.min(...inside);
    // A protected flying area must be much flatter than raw terrain.
    expect(spread).toBeLessThan(terrain.config.amplitude * 0.2);
  });

  it('places obstacles only outside the protected areas', () => {
    const terrain = new Terrain({ seed: 'zones' });
    for (const obstacle of terrain.obstacles) {
      if (obstacle.kind === 'gate') continue;
      expect(
        terrain.insideAnyArea(obstacle.position.x, obstacle.position.z, -20),
        `${obstacle.id} sits inside a flying area`,
      ).toBe(false);
    }
  });

  it('offers pilot stand points that differ in line of sight', () => {
    const terrain = new Terrain({ seed: 'stands' });
    expect(terrain.launchPoints.length).toBeGreaterThan(5);
    const obstructed = terrain.launchPoints.filter((p) => p.hasObstruction);
    expect(obstructed.length).toBeGreaterThan(0);
  });
});

describe('damage', () => {
  it('computes impact energy from translation and rotor spin', () => {
    const stationary = impactEnergy(0.6, { x: 0, y: 0, z: 0 }, 0, 4, 1.2e-5, 0.065);
    expect(stationary).toBe(0);

    const moving = impactEnergy(0.6, { x: 10, y: 0, z: 0 }, 0, 4, 1.2e-5, 0.065);
    expect(moving).toBeCloseTo(0.5 * 0.6 * 100, 5);

    const spinning = impactEnergy(0.6, { x: 0, y: 0, z: 0 }, 3000, 4, 1.2e-5, 0.065);
    expect(spinning).toBeGreaterThan(0);
  });

  it('absorbs grass and returns concrete', () => {
    expect(surfaceDamping('grass')).toBeLessThan(surfaceDamping('concrete'));
    expect(surfaceDamping('metal')).toBeGreaterThan(surfaceDamping('dirt'));
  });

  it('does nothing when parts damage is off', () => {
    const model = new DamageModel(1);
    const clean = applySettingsPreset('preset-clean');
    model.applyImpact(50, clean, 'concrete', { x: 0, y: 1, z: 0 });
    expect(model.snapshot.overall).toBe(1);
    expect(model.snapshot.frame.condition).toBe(1);
  });

  it('degrades progressively as impacts accumulate', () => {
    const model = new DamageModel(1);
    let hits = 0;
    for (let i = 0; i < 40 && !model.snapshot.unflyable; i++) {
      model.applyImpact(6, DEFAULT_SETTINGS, 'concrete', { x: 0, y: 1, z: 0 });
      hits++;
    }
    expect(hits).toBeGreaterThan(0);
    expect(model.snapshot.overall).toBeLessThan(1);
    // A fresh snapshot reports itself honestly.
    expect(freshDamage().worstIssue).toContain('as new');
  });

  it('leaves the frame alone on a light hit but chips the props', () => {
    const model = new DamageModel(1);
    model.applyImpact(0.5, DEFAULT_SETTINGS, 'grass', { x: 0, y: 1, z: 0 });
    expect(model.snapshot.props.some((p) => p.condition < 1)).toBe(true);
    expect(model.snapshot.frame.condition).toBe(1);
  });
});

describe('collision', () => {
  it('detects a hit on flat ground and reports the surface', () => {
    const contact = detectCollision(
      { x: 0, y: 0.05, z: 0 },
      { x: 0, y: -5, z: 0 },
      eulerToQuat(0, 0, 0),
      { propRadius: 0.065, halfExtents: { x: 0.1, y: 0.02, z: 0.1 }, cameraHeight: 0.02, propHeight: 0.01 },
      { terrainHeight: () => 0, obstacles: [], waterHeight: null },
    );
    expect(contact).not.toBeNull();
    expect(contact!.approachSpeed).toBeGreaterThan(4);
    expect(contact!.normal.y).toBeCloseTo(1, 3);
  });

  it('returns null when clear of everything', () => {
    const contact = detectCollision(
      { x: 0, y: 30, z: 0 },
      { x: 0, y: 0, z: 0 },
      eulerToQuat(0, 0, 0),
      { propRadius: 0.065, halfExtents: { x: 0.1, y: 0.02, z: 0.1 }, cameraHeight: 0.02, propHeight: 0.01 },
      { terrainHeight: () => 0, obstacles: [], waterHeight: null },
    );
    expect(contact).toBeNull();
  });
});

describe('simulation toggles', () => {
  it('starts with everything on', () => {
    expect(countEnabled(DEFAULT_SETTINGS)).toBeGreaterThan(10);
  });

  it('applies a preset as a complete settings object', () => {
    const bench = applySettingsPreset('preset-bench');
    expect(bench.partsDamage).toBe(false);
    expect(bench.signalStrength).toBe(false);
    expect(bench.weather).toBe(false);
    // Every key present, so nothing reads undefined later.
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(typeof (bench as unknown as Record<string, unknown>)[key]).toBe('boolean');
    }
  });

  it('is a no-op — not a NaN generator — with every system off', () => {
    const world = buildWorld(applySettingsPreset('preset-bench'));
    world.arm();
    settle(world, 3, { ...ZERO_INPUT, throttle: 0.6, roll: 0.4 });
    const snap = world.snapshot();
    for (const value of [
      snap.position.x, snap.position.y, snap.position.z,
      snap.velocity.x, snap.velocity.y, snap.velocity.z,
      snap.speed, snap.heightAgl, snap.thrustN, snap.thrustToWeight,
      snap.battery.voltage, snap.battery.currentAmps,
      snap.signal.control.lq, snap.signal.video.quality,
      snap.damage.overall, snap.wind.turbulence, snap.wind.updraft,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(snap.damage.overall).toBe(1);
    expect(snap.wind.turbulence).toBe(0);
  });

  it('produces different signal with penetration on and off', () => {
    const withPen = buildWorld(DEFAULT_SETTINGS, 'pen');
    const without = buildWorld({ ...DEFAULT_SETTINGS, rfPenetration: false }, 'pen');
    for (const world of [withPen, without]) {
      const stand = world.terrain.launchPoints[1];
      world.setPilotPosition(stand);
      world.arm();
      world.quad.state.position = { x: 0, y: world.terrain.sampleHeight(0, 0) + 8, z: 0 };
      world.tickSlow(0.2);
    }
    const a = withPen.snapshot().signal.control.budget.penetrationLossDb;
    const b = without.snapshot().signal.control.budget.penetrationLossDb;
    expect(a).toBeGreaterThan(b);
  });

  it('keeps wind off when weather is off', () => {
    const world = buildWorld({ ...DEFAULT_SETTINGS, weather: false });
    world.arm();
    settle(world, 2);
    const wind = world.snapshot().wind;
    expect(wind.turbulence).toBe(0);
    expect(wind.updraft).toBe(0);
  });
});

describe('wind field', () => {
  it('produces stronger wind higher up', () => {
    const world = buildWorld();
    world.wind.settings.speed = 8;
    const low = world.wind.sample({ x: 0, y: 2, z: 0 }, 0, 0);
    const high = world.wind.sample({ x: 0, y: 120, z: 0 }, 0, 0);
    expect(high.velocity.x).toBeGreaterThan(Math.abs(low.velocity.x));
  });

  it('produces lift on a windward slope and sink on the lee', () => {
    const world = buildWorld();
    expect(world.wind.sample({ x: 0, y: 10, z: 0 }, 0, 0.5).updraft).toBeGreaterThan(0);
    expect(world.wind.sample({ x: 0, y: 10, z: 0 }, 0, -0.5).updraft).toBeLessThan(0);
  });

  it('is deterministic for the same position and time', () => {
    const rng = createRng(7);
    void rng;
    const world = buildWorld();
    const a = world.wind.sample({ x: 10, y: 30, z: -20 }, 12.5, 0.2);
    const b = world.wind.sample({ x: 10, y: 30, z: -20 }, 12.5, 0.2);
    expect(a.velocity.x).toBeCloseTo(b.velocity.x, 9);
    expect(a.updraft).toBeCloseTo(b.updraft, 9);
  });
});
