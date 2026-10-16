# AGENTS.md — FPV Lab

Operational contract for coding agents on this repo. **Read this before touching anything.**
Optimized for low token cost: follow the map, don't tour the codebase.

## 0. What this is

Browser-based FPV drone **builder + flight simulator + tuner**. One codebase ships to:
- **PC**: modern browser (WebGL2) via `npm run dev` / `npm run preview`.
- **Android**: same build wrapped by Capacitor into an APK (`npm run android:*`).

No backend, no accounts, no network calls at runtime. All assets are **generated in code**.

## 1. Golden path (use this first)

```bash
npm install
npm run dev              # PC, http://localhost:5173
npm run check            # tsc --noEmit + eslint  → MUST be clean before you finish
npm run build            # production web bundle → dist/
npm run android:sync     # dist/ → android/ project
npm run android:apk      # debug APK (needs Android SDK + JDK 17)
```

`npm run check` is the gate. Do not hand a turn back with type errors.

## 2. Repo map (only read what you need)

```
src/
  core/            PURE SIMULATION. No React, no three.js. Fully unit-testable.
    math/          vec3/quat/mat3, seeded RNG, gradient+ridged noise, fbm
    constants.ts   physical constants + every unit conversion
    parts/
      spec.ts      the `Part` union — the shape of a catalog entry
      ids.ts       `PartId`, inferred from the catalog data
      index.ts     registry, search, slot→category map
      presets.ts   the six default builds
      catalog/     the data itself, one file per category
    build/         rules.ts (fit validation) + resolve.ts (mass, CG, inertia, mixer)
    physics/       prop.ts · motor.ts · battery.ts · controller.ts · quadrotor.ts
    sim/           settings.ts · weather.ts · wind.ts · signal.ts · damage.ts
                   collision.ts · world.ts (the orchestrator)
    terrain/       procedural heightfield, obstacles, flying areas, stand points
    tuning/        PID/rate presets, authority derivation, tune analysis
  input/           types · mapping (stick modes) · manager · gamepad · radio · touch
  render/          textures (all procedural) · models · world · scene
  ui/              App.tsx, components.tsx, styles.css, panels/
  state/           store.ts — zustand + the single rAF loop
tests/             vitest. physics.test.ts (31) + signal.test.ts (32)
```

### Dependency rule (hard)
`core/` **must not import** from `render/`, `ui/`, `input/`, `three`, or `react`.
The dependency arrow points one way: `ui → state → core`, `render → core`.
If you need a sim value in the renderer, add it to the world snapshot, don't import upward.

Two consequences that have already bitten:
- `core/parts/ids.ts` exists separately from `core/parts/index.ts` precisely so
  `presets.ts` can name a `PartId` without a circular import. Don't merge them.
- `core/sim/world.ts` imports from `tuning/` at the *bottom* of the file, on
  purpose: the world's dependency list stays readable in one place.

### Where the state lives
- The `World` is a **plain mutable object, outside React**. It changes 500×/s and
  must never trigger a render. `snapshot()` produces an immutable per-tick view.
- React gets that snapshot republished at `SIM_UI_HZ` (20 Hz). The render loop in
  `state/store.ts` owns the frame order: poll input → step world → publish → draw.
  Do not add a second `requestAnimationFrame` loop anywhere.

## 3. The 5 data contracts

Change these and you change the app. Everything else is presentation.

| Contract | File | Notes |
|---|---|---|
| `Part` | `core/parts/spec.ts` | Discriminated union on `category`. Add fields **optional** with defaults in `catalog/`. |
| `BuildSpec` | `core/parts/presets.ts` | `{ id, name, slots }`. `slots` is mutable — the builder edits it in place. |
| `ResolvedBuild` | `core/build/resolve.ts` | mass/CG/inertia/battery/mixer. Recompute on any slot change. |
| `WorldSnapshot` | `core/sim/world.ts` | Immutable per-tick readout the UI renders. **Never** mutate from UI. |
| `RawSticks` | `input/types.ts` | Device-agnostic `{ leftX, leftY, rightX, rightY, buttons }`. |
| `InputFrame` | `input/types.ts` | Normalized `{ roll, pitch, yaw, throttle, switches }`. |

## 4. Units — SI everywhere, no exceptions

| Quantity | Unit | Gotcha |
|---|---|---|
| distance | **m** | FPV meshes are small: 5" prop ≈ 0.127 m |
| mass | **kg** | catalog stores grams, convert at load |
| time | **s** | physics dt fixed `1/500 s` |
| angle | **rad** | UI converts with `RAD2DEG` |
| force | **N** | thrust ≈ 2.4 N per gram at hover is typical |
| motor speed | **rad/s** | catalog stores Kv (RPM/V) — `Ke = 60 / (2π · Kv)` |
| resistance | **Ω** | catalog stores mΩ, divide by 1000 |
| current | **A** | |
| voltage | **V** | pack-level **and** per-cell |
| frequency | **Hz** | 2.4e9 etc. |

**Mixing units is the #1 source of wrong physics in this repo.** Convert once, at the
catalog boundary. Never store a "grams-only" field downstream.

## 5. Physics rules of engagement

Accuracy is a feature. Do not fake forces to make flight feel good.

1. **No magic thrust.** Thrust comes from `Kt · ω²` where `ω` comes from the motor
   electrical model (`L·dω/dt = Ke·I − Kq·ω²`). `core/physics/motor.ts`.
2. **Motor lag is real.** Betaflight ESC PWM → speed takes 20–60 ms. Model it
   (`MOTOR_TAU`). Removing it makes the drone feel like a toy.
3. **Drag is anisotropic and body-relative.** A 5" quad has ~5× the frontal area
   edge-on. Rotate the drag tensor with the body orientation.
4. **Battery sag feeds back into thrust.** Never compute thrust from nominal voltage.
   Motor current must drain the cell model, sag reduces V, thrust drops. This is the
   single most important realism loop in the app.
5. **Coulomb counting for SoC**, not a linear timer. `dSoC = −I·dt / (3600 · Q)`.
6. **Fixed timestep.** `world.step(dt)` substeps at 500 Hz. Never tie physics to frame
   rate. If it hitches, clamp the frame's total sim time; do not change the substep.
7. **The flight controller drives the mixer, not the sticks.** `controller.ts` turns
   a stick into a *rate setpoint*; the P/I/D/F sum is the mixer demand. Raw gains are
   Betaflight-scale (P ~50) and need the `P_NORMALISE` family to fit a `[-1, 1]`
   output — skip those constants and the quad shakes itself apart.
8. **It is a rate controller.** A held stick commands a rotation *rate*, so the quad
   loops. Fly forward by tilting to an angle and neutralising, like a real pilot.
9. Ground effect, advance-ratio thrust, propwash and wind drag are implemented —
   use them, don't re-derive them.
10. Contacts need **both** velocity resolution and positional correction. Resolving
    velocity alone lets the drone sink through terrain over several frames.

> Calibration anchors the tests hold the model to. If you change a constant, these
> must still pass: hover on 6S at **~40% throttle / ~33 A / ~15 500 rpm**; full
> throttle **ESC-limited at ~100 A and ~2 kgf static (T/W ~3)**; cruise
> **25–42 m/s**. See `tests/physics.test.ts` and `tests/signal.test.ts`.

## 6. Simulation toggles (all optional, all defaulted)

Every system is gated by a flag in `core/sim/settings.ts`:
`partsDamage` (frame / electronics / props / camera), `signalStrength` (video,
control, RF penetration, multipath), `batterySag`, `batteryThermal`, `weather`
(wind, rain, fog, time of day, air density), `propwash`, `failsafe`.

**Disabling a flag must make it a no-op, not a NaN generator.** When you add a new
system: read `settings` at the top of the step, early-return when off, and keep the
snapshot fields at their neutral defaults. `signal.test.ts` has a test asserting
every snapshot field is finite with everything off — keep it passing.

## 7. Parts catalog rules

- The catalog is **real-world data**. Real part numbers, real published specs. When you
  add a part, use the maker's actual KV/R/current/thrust — do not invent round numbers.
- Store the unit the datasheet uses (`kvRpmPerVolt`, `phaseResistanceMilliOhm`,
  `massGrams`). Resolve to SI in `resolve.ts`. This is why those fields carry units.
- `phaseResistanceMilliOhm` is the **effective loaded** resistance, not the DC
  winding figure a milliohm meter reads. It is calibrated so the simulated operating
  points match published field data. A datasheet DC value is ~6× lower and will
  make the motor model unsolvable. See the comment on the field in `spec.ts`.
- Prop coefficients are **derived from pitch ratio**, not stored — a prop is always
  self-consistent. `figureOfMerit` is the only free parameter (0.55–0.65).
- Adding a part = one entry in `parts/catalog/*.ts`. `PartId` widens automatically
  (it is inferred from the data), so no type edit is needed.
- **Presets in `parts/presets.ts` are the default builds.** They must stay valid
  against `build/rules.ts`. A test asserts every preset is error-free.

## 8. UI conventions

- Panels are dumb. They read from `state/store.ts` and dispatch `actions.*`. No physics
  inside a React component.
- Simulation values update at 20 Hz (`SIM_UI_HZ`), NOT every frame. Rendering the
  physics tick into React is what melts Android. See "Where the state lives" above.
- React `key` by part id / panel id, never by array index, for reorderable lists.
- Android: every touch target ≥ 44 px (`--tap`), controls reachable in portrait **and**
  landscape, no hover-only affordances. Test by rotating.
- `html, body, #root` set `overscroll-behavior: none` and `touch-action: none` so the
  Capacitor webview does not scroll or zoom mid-flight. Don't remove these.
- **Drivers emit raw gimbals; only `mapping.ts` turns them into channels.** Stick mode
  is applied in exactly one place, so a RadioMaster and a gamepad behave identically.
  Respect that or the two devices drift apart.

## 8b. Rendering

- Textures and meshes are **generated in code** from a seeded RNG (`mulberry32` /
  `Noise2D`). Never add a binary asset. Deterministic from the terrain seed string.
- The drone mesh is built from the `ResolvedBuild`, so it is always the physics. If you
  see a mismatch, the model is wrong, not the resolver.
- Quality is tiered by device (`detectTier()`): pixel ratio and shadow map size drop on
  low-end hardware. Keep new effects inside the tier check.
- The FPV camera inherits the video link: analog snow and rolling tear, digital frame
  drops, prop vibration, and a cracked camera's jitter. That coupling is the point of
  the render layer — do not "clean it up".

## 9. Art & audio

All procedural, in `render/textures.ts` and `render/models.ts`. No binary assets, no
downloads, no licenses. If a new mesh is needed, build it from primitives with a seeded
`mulberry32` RNG so the world is deterministic from a seed string.
Adding a CC0 pack later is allowed, but must go in `render/vendor/` with a
`CREDITS.md` and stay **optional** (feature-detect and fall back to procedural).

## 10. Git & hygiene

- Conventional commits: `feat:`, `fix:`, `perf:`, `refactor:`, `test:`, `docs:`.
- One concern per commit. Never mix a refactor with a behavior change.
- No dead code, no commented-out blocks, no "TODO: later". If unsure, delete it.
- Keep files focused; >400 lines in `core/` means split it.
- Update `AGENTS.md` **only** if you changed a contract in §3 or a rule in §5/§6.
  Do not restate what code already says.

## 11. Agent efficiency — read this, it is the point of this file

- **Never** read a whole directory to "get oriented". Read `package.json` + the §2
  entry for the area you are changing. That's usually enough.
- **Grep for the symbol, not the file.** If you need `InertiaTensor`, grep it and read
  60 lines of context — not the 900-line module.
- **Do not re-read a file you already read this session.** Only re-read if you or a
  tool changed it.
- **Batch independent tool calls in one block.** Parallel reads/writes over sequential
  ones is the cheapest win available.
- **Look before you write.** `grep` for an existing implementation before adding one.
  Most "new" utilities already exist in `core/math`.
- **Don't summarize the repo back to the user.** Report the diff and the test result.
- **Match surrounding style** — naming, comment density, error handling. Consistency
  beats your personal preference.
- **Stop at the requested scope.** If asked for one panel, don't refactor the router.

## 12. Definition of done

- [ ] `npm run check` clean (typecheck + lint + tests), and `npm run build` succeeds
- [ ] Pure `core/` — no React/three/input imports
- [ ] New system honours its settings flag and is a no-op when off
- [ ] Units obey §4; catalog keeps datasheet units, sim uses SI
- [ ] Physics still hits the §5 calibration anchors
- [ ] Touch-usable on Android, keyboard/mouse-usable on PC
- [ ] No new binary assets, no network calls, no TODOs
