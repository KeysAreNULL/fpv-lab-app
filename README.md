# FPV Lab

An FPV drone **builder, simulator and tuner** that runs in a browser on PC and
installs as an APK on Android. Real parts, real physics, and a simulation you
can turn parts of off.

Built with React, TypeScript, three.js and Capacitor. No backend, no accounts, no
binary assets — every texture and mesh is generated in code.

---

## Quick start

```bash
npm install
npm run dev        # PC: http://localhost:5173
```

Android:

```bash
npm run android:apk    # → android/app/build/outputs/apk/debug/app-debug.apk
```

See [`docs/android.md`](docs/android.md) for the SDK prerequisites.

## Controls

| | |
|---|---|
| **Desktop keyboard** | `Shift` raise throttle · `Ctrl` lower · `W/S` pitch · `A/D` roll · `Q/E` yaw · `Space` arm · `B` buzzer · `R` record |
| **Gamepad** | Any controller. Gimbals on axes 0–3, control surfaces on the face buttons. Auto-detected on plug-in. |
| **ELRS radio** | Controls → *Connect radio (USB)*. Reads ELRS joystick frames over Web Serial. |
| **Touch** | On-screen gimbals, draggable to wherever your thumbs fall, plus ARM / ANG / ACRO. |

Stick mode 1–4 follows the real Betaflight table, and is applied in one place for
every device — so a RadioMaster in mode 2 and a gamepad in mode 2 behave
identically.

---

## What it simulates

### Builder — a catalogue of real parts

~90 real parts with datasheet specs: frames (GEPRC Mark5 HD, ImpulseRC Apex EVO,
TBS Source One 7, Meteor 65, Nazgul Evo), motors (T-Motor F60 Pro V, iFlight
XING2 2207, Foxeer Vortex 2812), stacks and ESCs, analog and digital video
(DJI O3, HDZero Race V3, WalkSnail, Runcam Swift, Foxeer Predator), lenses,
antennas, ELRS/Crossfire receivers and radios, and LiPo packs.

Six default builds (freestyle 5", DJI O3 race, 7" long range, 3" whoop, 6" and
3.5" cinewhoop). Swapping a part re-resolves the build live: all-up weight, mass
breakdown, CG, inertia tensor, hover current, hover RPM, thrust-to-weight, wheel
base and estimated range all update, and you get told what does not physically
fit.

### Physics

The parts are the model, not decoration:

- **Motors** solve `Ke·ω + I·R` against the prop load each substep. Thrust is
  `Ct·ρ·n²·D⁴` from the blade geometry, and the ESC's current ceiling is what
  actually caps thrust — a 5" quad on 6S makes about 2 kgf, not the theoretical 8.
- **Battery sag feeds back into thrust.** Motors draw current, current drops the
  terminal voltage, low voltage lowers motor speed. A 6S 1300 pack sags from
  25.2 V to about 24.5 V under a 100 A punchout and every motor feels it.
- **LiPo cell model** with a real discharge curve, internal resistance that rises
  as the pack empties and cools, I²R heating, and Coulomb counting for capacity.
- **Betaflight-style flight controller**: rate setpoints through the RC curve,
  then P, feedforward, D-on-measurement and I with anti-windup, all driving the
  mixer. It is a rate controller, so holding a stick commands a rotation *rate* —
  fly forward by tilting to an angle, like a real pilot.
- Anisotropic body drag, ground effect, advance-ratio thrust, propwash, contact
  resolution with real restitution and friction per surface.

Calibrated against published field data, and locked by tests: hover at ~40%
throttle and ~33 A on 6S, full throttle capped by the ESC at ~100 A and ~2 kgf.

### Environment

- **Weather and time of day** — the sun position is real solar astronomy for the
  map's latitude, so a winter sun is genuinely low and the shadows are long.
  Rain, cloud, haze, temperature and humidity are all live and all feed the sim:
  air density, prop efficiency, lens fogging, pack internal resistance.
- **Wind** — a power-law boundary layer (which is what makes ridge lift work),
  gusts at two time scales, and obstacle effects: buildings and pylons generate
  lee-side rotor, sink and turbulence, and windward faces deflect air upward.
  Terrain slope projected onto the wind drives orographic lift.
- **Terrain** is procedural from a seed string — ridged fbm hills, a town, a
  pylon line, hangars, rocks and tree stands — with three **designated flying
  areas** that are deliberately flattened, obstacle-free and marked with gates.

### Signal

A real link budget for both the control link and the video downlink:

```
Rx (dBm) = Tx power + gains − FSPL − penetration − Fresnel diffraction
```

Obstructions between pilot and drone attenuate by material (reinforced concrete
22 dB/m, drywall 3 dB/m), and **an obstacle inside the first Fresnel zone
attenuates far more than the same obstacle outside it** — so a hillside directly
behind you kills the link while the same hillside 200 m to the side does not.
Multipath fading deepens around scatterers.

Analog and digital then diverge the way they really do: analog degrades
gradually into snow and a rolling tear, digital holds a clean picture and then
drops frames and cuts to black. The FPV camera inherits all of it.

**Where you stand is a real input.** Pick a different spot on the map panel and
the link geometry, the obstruction list and the local wind all change. The map
shows each stand point's view cone and live link budget.

### Damage

Impacts apply kinetic energy including rotor spin, so flipping at full throttle
destroys props that a gentle nose-in would not touch. Props chip and throw a
vibration that shows up in the video before it shows up in the handling; arms
bend and make the drone drift toward the bent corner; the FC loses authority and
desyncs; the camera cracks, grows dead pixels and fogs in the rain.

---

## Toggles

Every optional system is gated and defaulted on. Turning one off makes it a
genuine no-op — the simulation stops paying for it rather than producing
different numbers. There is a test asserting that nothing goes NaN with
everything off.

**Parts damage** (master / frame / props / electronics / camera) ·
**Signal strength** (master / video / control / RF penetration / multipath) ·
**Battery** (sag, thermal) ·
**Weather** (wind, rain, haze, time of day, air density) ·
**Flight behaviour** (propwash, failsafe)

Plus presets: *Full Simulation*, *Clean Build*, *Endurance*, *Perfect Link*,
*Bench Test*, *Wet Multirotor*.

---

## Tuning

Betaflight conventions, so the numbers mean something to anyone who has tuned a
quad: P 35–60, I 28–45, D 26–40, F 85–130 for a 5".

The P term is not cosmetic — it sets the controller's authority over the mixer,
so raising P genuinely changes how the quad handles, and overdoing it oscillates.
The notch filter is pre-set to the airframe's own resonance, which is computed
from the frame and prop. A static analyser flags the combinations that reliably
produce a bad flight, which is more useful than a row of sliders.

---

## Development

```bash
npm run dev      # dev server
npm run check    # tsc --noEmit + eslint + vitest — must be clean
npm test         # 63 tests: physics, signal, terrain, damage, toggles
npm run build    # → dist/
```

See [`AGENTS.md`](AGENTS.md) for the repo map, the physics rules of engagement,
and the conventions an agent should follow here.
