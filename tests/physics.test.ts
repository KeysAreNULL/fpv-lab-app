import { describe, expect, it } from 'vitest';
import { GRAVITY, airDensity } from '../src/core/constants';
import { resolveBuild } from '../src/core/build/resolve';
import { defaultBuilds, findBuild, emptyBuild, type BuildSpec } from '../src/core/parts/presets';
import { findPart } from '../src/core/parts';
import type { BatteryPart } from '../src/core/parts/spec';
import { Quadrotor, PHYSICS_DT, ZERO_INPUT, type ControlInput } from '../src/core/physics/quadrotor';
import { Battery } from '../src/core/physics/battery';
import { createDefaultTune } from '../src/core/tuning/tuner';
import { validateBuild, canArm } from '../src/core/build/rules';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Minimal environment for a physics test. */
const calm = (groundHeight = 0) => ({
  rho: airDensity(10, 20),
  wind: { x: 0, y: 0, z: 0 },
  groundHeight,
});

/** A mutable copy of a preset, so tests can swap parts freely. */
function variant(spec: BuildSpec, slots: Partial<BuildSpec['slots']>): BuildSpec {
  return { ...spec, id: 'test', slots: { ...spec.slots, ...slots } };
}

/** Run the sim for `seconds` at a fixed input. */
function fly(
  quad: Quadrotor,
  seconds: number,
  input: Partial<ControlInput>,
  env = calm(-50),
) {
  const tune = quad.build ? createDefaultTune(quad.build) : null;
  void tune;
  const steps = Math.round(seconds / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    quad.step(PHYSICS_DT, { ...ZERO_INPUT, ...input }, env, quadTune(quad), 1);
  }
  return quad.state;
}

/** The tune a quad was built with is kept on the quad's build; rebuild per fly. */
const tuneCache = new WeakMap<Quadrotor, ReturnType<typeof createDefaultTune>>();
function quadTune(quad: Quadrotor): ReturnType<typeof createDefaultTune> {
  let tune = tuneCache.get(quad);
  if (!tune) {
    tune = createDefaultTune(quad.build);
    tuneCache.set(quad, tune);
  }
  return tune;
}

/** Find the throttle that holds altitude from a given start height. */
function hoverThrottle(build: ReturnType<typeof resolveBuild>, startY = 40): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const probe = new Quadrotor(build, 20);
    probe.reset({ x: 0, y: startY, z: 0 });
    const tune = createDefaultTune(build);
    for (let s = 0; s < Math.round(4 / PHYSICS_DT); s++) {
      probe.step(PHYSICS_DT, { ...ZERO_INPUT, throttle: mid }, calm(-50), tune, 1);
    }
    if (probe.state.velocity.y > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

describe('build resolution', () => {
  it('every default preset is a flyable build', () => {
    for (const preset of defaultBuilds) {
      const issues = validateBuild(preset).filter((i) => i.level === 'error');
      expect(issues, `${preset.name}: ${issues.map((i) => i.message).join(' | ')}`).toHaveLength(0);
      expect(canArm(preset)).toBe(true);
    }
  });

  it('resolves a 5" freestyle build to a realistic all-up weight', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    // GEPRC Mark5 (148 g) + 4 motors + 4 props + stack + video + 6S 1300 lands
    // in the 500–700 g band that every 5" freestyle quad sits in.
    expect(build.auwKg).toBeGreaterThan(0.45);
    expect(build.auwKg).toBeLessThan(0.72);
    expect(build.electrical.cells).toBe(6);
  });

  it('produces a plausible inertia tensor', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const [ixx, , , , iyy, , , , izz] = build.inertia;
    for (const value of [ixx, iyy, izz]) {
      expect(value).toBeGreaterThan(5e-4);
      expect(value).toBeLessThan(0.02);
    }
    // Yaw inertia is the largest for a quad: mass sits furthest from the Y axis.
    expect(iyy).toBeGreaterThan(ixx);
    expect(izz).toBeCloseTo(ixx, 6);
  });

  it('puts the CG slightly low and behind centre, as a battery-dominant build does', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    expect(build.cg.y).toBeLessThan(0);
    expect(build.cg.z).toBeLessThan(0);
  });

  it('rejects a motor that does not fit the frame', () => {
    const spec = variant(findBuild('preset-freestyle-5-analog'), {
      motor: 'motor-se0702-17000kv',
    });
    const errors = validateBuild(spec).filter((i) => i.level === 'error');
    expect(errors.some((e) => e.slot === 'motor')).toBe(true);
  });

  it('rejects a digital VTX with a separate analog camera', () => {
    const spec = variant(findBuild('preset-race-5-digital-o3'), {
      camera: 'cam-foxeer-predator-v5',
    });
    expect(validateBuild(spec).some((i) => i.level === 'error' && i.slot === 'camera')).toBe(true);
  });

  it('rejects a mismatched control protocol', () => {
    const spec = variant(findBuild('preset-freestyle-5-analog'), {
      rx: 'rx-tbs-crossfire-micro',
    });
    expect(validateBuild(spec).some((i) => i.level === 'error' && i.slot === 'tx')).toBe(true);
  });

  it('rejects a pack whose cell count the frame cannot take', () => {
    const spec = variant(findBuild('preset-whoop-3'), {
      battery1: 'batt-tattu-rline-v5-6s1300-100c',
    });
    expect(validateBuild(spec).some((i) => i.level === 'error' && i.slot === 'battery1')).toBe(true);
  });

  it('resolves an empty build without throwing', () => {
    const build = resolveBuild(emptyBuild());
    expect(build.auwKg).toBeGreaterThan(0);
    expect(Number.isFinite(build.inertia[0])).toBe(true);
  });
});

describe('flight controller', () => {
  it('holds attitude when the stick is centred', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 40, z: 0 });
    const tune = createDefaultTune(build);

    // Kick it over with a roll command, then release.
    for (let s = 0; s < Math.round(0.4 / PHYSICS_DT); s++) {
      quad.step(PHYSICS_DT, { ...ZERO_INPUT, throttle: 0.45, roll: 1 }, calm(-50), tune, 1);
    }
    for (let s = 0; s < Math.round(3 / PHYSICS_DT); s++) {
      quad.step(PHYSICS_DT, { ...ZERO_INPUT, throttle: 0.45 }, calm(-50), tune, 1);
    }

    // The controller must arrest the rotation, not let it tumble.
    const rate = Math.hypot(...Object.values(quad.state.controlDemand));
    expect(rate).toBeLessThan(0.25);
    expect(Math.abs(quad.state.angularVelocity.x)).toBeLessThan(1.5);
    expect(Math.abs(quad.state.angularVelocity.z)).toBeLessThan(1.5);
  });

  it('rolls right when commanded right and left when commanded left', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const tune = createDefaultTune(build);

    const rollTo = (stick: number) => {
      const quad = new Quadrotor(build, 20);
      quad.reset({ x: 0, y: 40, z: 0 });
      for (let s = 0; s < Math.round(0.5 / PHYSICS_DT); s++) {
        quad.step(PHYSICS_DT, { ...ZERO_INPUT, throttle: 0.45, roll: stick }, calm(-50), tune, 1);
      }
      // ω.z > 0 rolls left, so a right stick must give ω.z < 0.
      return quad.state.angularVelocity.z;
    };

    expect(rollTo(1)).toBeLessThan(-0.5);
    expect(rollTo(-1)).toBeGreaterThan(0.5);
  });

  it('yaws right when commanded right', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const tune = createDefaultTune(build);
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 40, z: 0 });
    for (let s = 0; s < Math.round(0.5 / PHYSICS_DT); s++) {
      quad.step(PHYSICS_DT, { ...ZERO_INPUT, throttle: 0.6, yaw: 1 }, calm(-50), tune, 1);
    }
    // ω.y > 0 yaws left, so a right stick must give ω.y < 0.
    expect(quad.state.angularVelocity.y).toBeLessThan(-0.3);
  });

  it('loses authority when the controller is told to', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const tune = createDefaultTune(build);
    const demandAt = (authority: number) => {
      const quad = new Quadrotor(build, 20);
      quad.reset({ x: 0, y: 40, z: 0 });
      for (let s = 0; s < Math.round(0.4 / PHYSICS_DT); s++) {
        quad.step(PHYSICS_DT, { ...ZERO_INPUT, throttle: 0.5, pitch: 1 }, calm(-50), tune, authority);
      }
      return Math.abs(quad.state.controlDemand.pitch);
    };
    expect(demandAt(0.25)).toBeLessThan(demandAt(1));
  });
});

describe('hover', () => {
  it('predicts a hover current in the published band', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    // A 6S 5" quad hovers at roughly 30–50 A total.
    expect(build.electrical.hoverAmpsTotal).toBeGreaterThan(25);
    expect(build.electrical.hoverAmpsTotal).toBeLessThan(60);
  });

  it('hovers at the throttle the physics says it should', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const throttle = hoverThrottle(build);
    // Published data: a 5" quad on 6S hovers around 30–50% throttle.
    expect(throttle).toBeGreaterThan(0.2);
    expect(throttle).toBeLessThan(0.62);
  });

  it('holds altitude at that throttle', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const throttle = hoverThrottle(build);
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 40, z: 0 });
    const tune = createDefaultTune(build);

    // Let it settle, then check it is neither climbing nor sinking.
    for (let s = 0; s < Math.round(4 / PHYSICS_DT); s++) {
      quad.step(PHYSICS_DT, { ...ZERO_INPUT, throttle }, calm(-50), tune, 1);
    }
    expect(Math.abs(quad.state.velocity.y)).toBeLessThan(1.5);

    // And measure the current at that point.
    expect(quad.state.battery.currentAmps).toBeGreaterThan(25);
    expect(quad.state.battery.currentAmps).toBeLessThan(70);
  });
});

describe('full throttle behaviour', () => {
  it('caps thrust at the ESC current ceiling rather than running away', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 40, z: 0 });
    fly(quad, 2, { throttle: 1 }, calm(-200));

    const thrustToWeight = quad.state.thrustN / (build.auwKg * GRAVITY);
    // A 6S 5" quad makes roughly 2–5× its own weight in static thrust before
    // the ESC saturates. More than that is not physical.
    expect(thrustToWeight).toBeGreaterThan(1.5);
    expect(thrustToWeight).toBeLessThan(9);
    expect(quad.motorStates.some((m) => m.currentLimited)).toBe(true);
  });

  it('sags the pack voltage under load and recovers it', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 40, z: 0 });

    fly(quad, 1.5, { throttle: 0 }, calm(-50));
    const resting = quad.state.battery.voltage;

    fly(quad, 0.8, { throttle: 1 }, calm(-50));
    const loaded = quad.state.battery.voltage;
    expect(loaded).toBeLessThan(resting - 0.3);

    fly(quad, 1.5, { throttle: 0 }, calm(-50));
    expect(quad.state.battery.voltage).toBeGreaterThan(loaded);
  });

  it('accelerates forward under forward stick and flies at a believable speed', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const tune = createDefaultTune(build);
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 60, z: 0 });
    const env = calm(-300);
    const hover = hoverThrottle(build, 60);
    const targetTilt = 0.45; // rad nose-down

    // Betaflight is a *rate* controller, so a constant stick command holds a
    // constant rotation rate and the quad loops forever — correct acro
    // behaviour, but not what "flies at 120 km/h" means. A pilot flies forward
    // by tilting to an angle and then neutralising, so the autopilot below does
    // angle-hold on top of the rate loop.
    for (let s = 0; s < Math.round(10 / PHYSICS_DT); s++) {
      const st = quad.state;
      const basis = quad.basis();
      const tiltDown = -Math.asin(clamp(basis.forward.y, -1, 1));
      const pitch = clamp((targetTilt - tiltDown) * 2, -1, 1);
      const throttle = clamp(hover + (60 - st.position.y) * 0.02 - st.velocity.y * 0.05, 0, 1);
      quad.step(PHYSICS_DT, { ...ZERO_INPUT, throttle, pitch }, env, tune, 1);
    }

    const forward = Math.hypot(quad.state.velocity.x, quad.state.velocity.z);
    // A 5" on 6S cruises at 90–150 km/h; that is 25–42 m/s.
    expect(forward).toBeGreaterThan(14);
    expect(forward).toBeLessThan(60);
    // And it should still be roughly where it started.
    expect(Math.abs(quad.state.position.y - 60)).toBeLessThan(30);
  });

  it('tracks a commanded rate instead of tumbling', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const tune = createDefaultTune(build);
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 40, z: 0 });
    for (let s = 0; s < Math.round(1 / PHYSICS_DT); s++) {
      quad.step(PHYSICS_DT, { ...ZERO_INPUT, throttle: 0.5, roll: 1 }, calm(-50), tune, 1);
    }
    // Betaflight is a rate controller: the commanded rate is met, not an angle.
    const commanded = quad.controller.debug.setpointDegS.roll;
    const actual = Math.abs(quad.controller.debug.actualDegS.roll);
    expect(actual).toBeGreaterThan(commanded * 0.7);
    expect(actual).toBeLessThan(commanded * 1.3);
  });
});

describe('battery integration', () => {
  const pack = () => new Battery(findPart('batt-tattu-rline-v5-6s1300-100c') as BatteryPart, 20);

  it('drains charge at the measured current, by Coulomb counting', () => {
    const battery = pack();
    battery.recharge();
    const start = battery.state.soc;
    battery.step(90, 0.002);
    battery.step(90, 0.002);
    // Each of the 6 cells only supplies I/6, so dSoC = -(I/cells)·dt/(3600·Q).
    const expectedDrain = ((90 / 6) * 0.004) / (3600 * 1.3);
    expect(start - battery.state.soc).toBeCloseTo(expectedDrain, 6);
  });

  it('sags under load and recovers when the load is removed', () => {
    const battery = pack();
    battery.recharge();
    const resting = battery.state.voltage;
    expect(resting).toBeCloseTo(25.2, 1);

    for (let i = 0; i < 20; i++) battery.step(120, 0.002);
    const loaded = battery.state.voltage;
    // 120 A through a 6.5 mΩ pack is a ~0.8 V drop.
    expect(loaded).toBeLessThan(resting - 0.5);
    expect(loaded).toBeGreaterThan(resting - 3);

    for (let i = 0; i < 20; i++) battery.step(0, 0.002);
    expect(battery.state.voltage).toBeGreaterThan(loaded);
  });

  it('holds more charge when warm than when cold', () => {
    const warm = new Battery(findPart('batt-tattu-rline-v5-6s1300-100c') as BatteryPart, 25);
    const cold = new Battery(findPart('batt-tattu-rline-v5-6s1300-100c') as BatteryPart, 0);
    warm.recharge();
    cold.recharge();
    for (let i = 0; i < 5; i++) warm.step(60, 0.002);
    for (let i = 0; i < 5; i++) cold.step(60, 0.002);
    expect(cold.state.voltage).toBeLessThan(warm.state.voltage);
  });

  it('reports a finite flight time that shrinks as the pack empties', () => {
    const battery = pack();
    battery.recharge();
    const full = battery.remainingSeconds(40);
    expect(Number.isFinite(full)).toBe(true);
    expect(battery.remainingSeconds(80)).toBeCloseTo(full / 2, 1);
  });
});

describe('stability', () => {
  it('does not blow up with the controls centred and no throttle', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 50, z: 0 });
    fly(quad, 5, {}, calm(-50));

    const s = quad.state;
    expect(Number.isFinite(s.position.y)).toBe(true);
    expect(Math.abs(s.angularVelocity.x)).toBeLessThan(1);
    expect(Math.abs(s.angularVelocity.y)).toBeLessThan(1);
  });

  it('stays finite across every preset', () => {
    for (const preset of defaultBuilds) {
      const build = resolveBuild(preset);
      const quad = new Quadrotor(build, 20);
      quad.reset({ x: 0, y: 20, z: 0 });
      fly(quad, 2, { throttle: 0.5, roll: 0.8, pitch: -0.7, yaw: 0.6 }, calm(-50));
      const s = quad.state;
      expect(Number.isFinite(s.position.x), preset.name).toBe(true);
      expect(Number.isFinite(s.position.y), preset.name).toBe(true);
      expect(Number.isFinite(s.orientation.w), preset.name).toBe(true);
      expect(Number.isFinite(s.thrustN), preset.name).toBe(true);
    }
  });

  it('keeps the orientation quaternion normalised', () => {
    const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
    const quad = new Quadrotor(build, 20);
    quad.reset({ x: 0, y: 20, z: 0 });
    fly(quad, 3, { throttle: 0.5, roll: 0.9, pitch: 0.7 }, calm(-50));
    const q = quad.state.orientation;
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 5);
  });
});

describe('mixer', () => {
  const build = resolveBuild(findBuild('preset-freestyle-5-analog'));
  const quad = new Quadrotor(build, 20);

  it('adds throttle symmetrically to all four motors', () => {
    const mixed = quad.mix(0.5, { roll: 0, pitch: 0, yaw: 0 });
    expect(mixed.every((t) => Math.abs(t - 0.5) < 1e-9)).toBe(true);
  });

  it('rolls right by reducing the right-hand motors', () => {
    const neutral = quad.mix(0.5, { roll: 0, pitch: 0, yaw: 0 });
    const right = quad.mix(0.5, { roll: 0.3, pitch: 0, yaw: 0 });
    // Motors 0 and 1 are the right-hand pair.
    expect(right[0]).toBeLessThan(neutral[0]);
    expect(right[1]).toBeLessThan(neutral[1]);
    expect(right[2]).toBeGreaterThan(neutral[2]);
    expect(right[3]).toBeGreaterThan(neutral[3]);
  });

  it('pitches nose-down by raising the rear motors', () => {
    const neutral = quad.mix(0.5, { roll: 0, pitch: 0, yaw: 0 });
    const nose = quad.mix(0.5, { roll: 0, pitch: 0.3, yaw: 0 });
    expect(nose[0]).toBeGreaterThan(neutral[0]);
    expect(nose[2]).toBeGreaterThan(neutral[2]);
    expect(nose[1]).toBeLessThan(neutral[1]);
    expect(nose[3]).toBeLessThan(neutral[3]);
  });

  it('clamps rather than wrapping when a stick is over-driven', () => {
    for (const t of quad.mix(0.5, { roll: 2, pitch: -2, yaw: 2 })) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });
});
