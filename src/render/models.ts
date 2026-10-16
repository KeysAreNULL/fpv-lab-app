/**
 * Procedural drone model.
 *
 * The mesh is generated from the *resolved build*, so what you see is what the
 * physics is using: prop diameter comes from the prop, motor bell size from the
 * motor, the camera and lens from the video parts, and the battery from the
 * pack's cell count. Swap a 5" prop for 7" props and the model grows.
 *
 * Everything is built from primitives and merged where possible. A five-inch
 * quad comes to roughly 4k triangles, which is comfortable on a mid-range
 * phone.
 */

import * as THREE from 'three';
import { inchToMeter } from '../core/constants';
import { LAYOUT, type ResolvedBuild } from '../core/build/resolve';
import { createRng } from '../core/math/rng';
import {
  aluminiumTexture,
  carbonFibreTexture,
  pcbTexture,
  plasticTexture,
  propBladeTexture,
} from './textures';

export interface DroneModel {
  /** Root group; the whole airframe is one transform. */
  root: THREE.Group;
  /** The four prop groups, in motor order, so they can spin independently. */
  props: THREE.Group[];
  /** Camera body group, for the camera's tilt if a cine build adds one. */
  camera: THREE.Group | null;
  /** Battery group, for a visual sagging when the pack is damaged. */
  battery: THREE.Group | null;
  /** Every mesh, so damage can tint the right part. */
  materials: THREE.Material[];
  dispose(): void;
}

const PROP_MATERIAL_CACHE = new Map<string, THREE.Material>();

/** Build the whole airframe. Call `dispose()` when the build changes. */
export function buildDroneModel(build: ResolvedBuild, seed = 'fpv-lab'): DroneModel {
  const root = new THREE.Group();
  root.name = 'drone';
  const rng = createRng(seed);
  const materials: THREE.Material[] = [];
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  const track = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    disposables.push(m);
    return m;
  };

  const propDiameter = build.propModel.diameterM;
  const propRadius = propDiameter / 2;
  const armLength = build.armM;

  // --- Carbon frame: a bottom plate, arms, and a top stack plate ------------
  const carbonTexture = carbonFibreTexture({ size: 256, seed: 'frame' });
  disposables.push(carbonTexture);
  const carbonMaterial = track(
    new THREE.MeshStandardMaterial({
      map: carbonTexture,
      color: 0x2a2d33,
      roughness: 0.42,
      metalness: 0.15,
    }),
  );

  const isWhoop = build.frame?.frameClass === 'whoop';
  const plateThickness = isWhoop ? 0.002 : Math.max(0.0025, (build.frame?.armThicknessMm ?? 5) / 1000);

  const bottomPlate = new THREE.Mesh(
    new THREE.BoxGeometry(armLength * 1.55, plateThickness, armLength * 1.55),
    carbonMaterial,
  );
  bottomPlate.name = 'bottomPlate';
  root.add(bottomPlate);

  const topPlate = new THREE.Mesh(
    new THREE.BoxGeometry(armLength * 1.1, plateThickness, armLength * 1.1),
    carbonMaterial,
  );
  topPlate.position.y = plateThickness * 2.6;
  root.add(topPlate);

  // Arms, angled outward toward the motor mounts.
  const armGeometry = new THREE.BoxGeometry(armLength * 1.05, plateThickness * 1.2, build.frame?.armThicknessMm ? (build.frame.armThicknessMm / 1000) * 1.8 : 0.01);
  for (const motor of build.motors) {
    const arm = new THREE.Mesh(armGeometry, carbonMaterial);
    arm.position.set(motor.position.x * 0.5, 0, motor.position.z * 0.5);
    arm.rotation.y = Math.atan2(motor.position.x, motor.position.z);
    arm.name = `arm-${motor.index + 1}`;
    root.add(arm);
  }
  disposables.push(armGeometry);

  // --- Motors ---------------------------------------------------------------
  const bellDiameter = build.motor?.bellDiameterMm ?? 22;
  const bellHeight = build.motor?.bellHeightMm ?? 16;
  const aluminium = aluminiumTexture({ size: 128, seed: 'motor' });
  disposables.push(aluminium);
  const bellMaterial = track(
    new THREE.MeshStandardMaterial({
      map: aluminium,
      color: 0x8a9099,
      roughness: 0.32,
      metalness: 0.85,
    }),
  );
  const statorMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.7, metalness: 0.4 }),
  );

  for (const motor of build.motors) {
    const motorGroup = new THREE.Group();
    motorGroup.name = `motor-${motor.index + 1}`;
    motorGroup.position.set(motor.position.x, 0, motor.position.z);

    const bell = new THREE.Mesh(
      new THREE.CylinderGeometry(
        inchToMeter(bellDiameter / 25.4 / 2),
        inchToMeter(bellDiameter / 25.4 / 2),
        inchToMeter(bellHeight / 25.4),
        16,
      ),
      bellMaterial,
    );
    bell.position.y = inchToMeter(bellHeight / 25.4) / 2;
    motorGroup.add(bell);

    // Stator showing through the bell vents.
    const stator = new THREE.Mesh(
      new THREE.CylinderGeometry(
        inchToMeter(bellDiameter / 25.4 / 2) * 0.86,
        inchToMeter(bellDiameter / 25.4 / 2) * 0.86,
        inchToMeter(bellHeight / 25.4) * 1.02,
        12,
      ),
      statorMaterial,
    );
    stator.position.y = bell.position.y;
    motorGroup.add(stator);

    root.add(motorGroup);
  }

  // --- Props -----------------------------------------------------------------
  const bladeTexture = propBladeTexture({ size: 128, seed: 'prop' });
  disposables.push(bladeTexture);
  const propMaterialKey = `prop-${build.propModel.ct.toFixed(4)}`;
  let propMaterial = PROP_MATERIAL_CACHE.get(propMaterialKey);
  if (!propMaterial) {
    propMaterial = new THREE.MeshStandardMaterial({
      map: bladeTexture,
      color: 0xffffff,
      roughness: 0.38,
      metalness: 0.08,
      transparent: true,
      side: THREE.DoubleSide,
      alphaTest: 0.35,
    });
    PROP_MATERIAL_CACHE.set(propMaterialKey, propMaterial);
  } else {
    disposables.push(propMaterial);
  }
  materials.push(propMaterial);

  const bladeCount = build.propModel.bladeCount;
  const props: THREE.Group[] = [];
  const bladeLength = propRadius * 0.94;
  // Real props are twisted. Approximating with a few segments keeps the count
  // low and the silhouette right.
  const bladeGeometry = new THREE.PlaneGeometry(bladeLength, propRadius * 0.3, 6, 1);
  {
    const position = bladeGeometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const along = (x + bladeLength / 2) / bladeLength;
      // Twist and sweep: more pitch near the root, narrower chord at the tip.
      position.setZ(i, -Math.sin(along * 0.7) * propRadius * 0.22);
      const scale = 1 - along * 0.35;
      position.setY(i, position.getY(i) * scale);
    }
    position.needsUpdate = true;
    bladeGeometry.computeVertexNormals();
  }
  disposables.push(bladeGeometry);

  const hubGeometry = new THREE.CylinderGeometry(propRadius * 0.14, propRadius * 0.16, propRadius * 0.12, 10);
  disposables.push(hubGeometry);

  build.motors.forEach((motor, index) => {
    const propGroup = new THREE.Group();
    propGroup.name = `prop-${index + 1}`;
    propGroup.position.set(motor.position.x, plateThickness * 1.6 + inchToMeter(bellHeight / 25.4) * 0.4, motor.position.z);

    const hub = new THREE.Mesh(hubGeometry, bellMaterial);
    propGroup.add(hub);

    for (let b = 0; b < bladeCount; b++) {
      const blade = new THREE.Mesh(bladeGeometry, propMaterial);
      // The blade runs radially; shift it out by half the radius.
      blade.position.x = bladeLength / 2;
      blade.rotation.x = Math.PI / 2;
      blade.rotation.z = (b / bladeCount) * Math.PI * 2;
      blade.rotation.y = motor.spin > 0 ? 0.5 : -0.5;
      blade.name = `blade-${index + 1}-${b + 1}`;
      propGroup.add(blade);
    }
    root.add(propGroup);
    props.push(propGroup);
  });

  // --- Stack (FC/ESC), VTX, camera, lens ------------------------------------
  const pcb = pcbTexture({ size: 256, seed: 'fc' });
  disposables.push(pcb);
  const stackMaterial = track(
    new THREE.MeshStandardMaterial({ map: pcb, color: 0xffffff, roughness: 0.62, metalness: 0.15 }),
  );
  const plasticBlack = track(
    new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.65, metalness: 0.1 }),
  );
  const plasticWhite = track(
    new THREE.MeshStandardMaterial({
      map: plasticTexture([214, 214, 210], { size: 128, seed: 'cam' }),
      roughness: 0.55,
      metalness: 0.05,
    }),
  );

  const stack = new THREE.Mesh(
    new THREE.BoxGeometry(0.032, 0.008, 0.032),
    stackMaterial,
  );
  stack.position.set(LAYOUT.stack.x, LAYOUT.stack.y + plateThickness, LAYOUT.stack.z);
  stack.name = 'stack';
  root.add(stack);

  if (build.frame?.frameClass !== 'whoop') {
    const vtx = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.006, 0.03),
      plasticBlack,
    );
    vtx.position.set(LAYOUT.vtx.x, LAYOUT.vtx.y + plateThickness, LAYOUT.vtx.z - 0.02);
    vtx.name = 'vtx';
    root.add(vtx);
  }

  let cameraGroup: THREE.Group | null = null;
  if (build.video.hasIntegratedCamera || build.spec.slots.camera) {
    cameraGroup = new THREE.Group();
    cameraGroup.name = 'camera';
    cameraGroup.position.set(
      LAYOUT.camera.x,
      LAYOUT.camera.y + plateThickness,
      LAYOUT.camera.z,
    );

    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.019, 0.019, 0.014), plasticWhite);
    cameraGroup.add(housing);

    // Lens barrel. The field of view the sim is using drives its length, so a
    // 1.4 mm ultra-wide really does have a shorter, wider barrel than a 2.1 mm.
    const fov = build.video.lensFovRad;
    const barrelLength = 0.004 + fov * 0.012;
    const barrelRadius = 0.006 + fov * 0.01;
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(barrelRadius, barrelRadius * 1.05, barrelLength, 14),
      plasticBlack,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 0.007 + barrelLength / 2;
    cameraGroup.add(barrel);

    const glass = new THREE.Mesh(
      new THREE.CircleGeometry(barrelRadius * 0.88, 16),
      track(
        new THREE.MeshStandardMaterial({
          color: 0x0a1620,
          roughness: 0.05,
          metalness: 0.4,
          envMapIntensity: 1.4,
        }),
      ),
    );
    glass.position.z = 0.007 + barrelLength - 0.0005;
    cameraGroup.add(glass);

    root.add(cameraGroup);
  }

  // --- Battery ---------------------------------------------------------------
  let batteryGroup: THREE.Group | null = null;
  if (build.battery) {
    const cells = build.battery.cells;
    const capacityFactor = Math.cbrt(build.battery.capacityMah / 1000);
    const width = 0.03 * capacityFactor;
    const length = 0.075 * capacityFactor;
    const height = 0.012 + cells * 0.0042;

    batteryGroup = new THREE.Group();
    batteryGroup.name = 'battery';
    batteryGroup.position.set(
      LAYOUT.battery.x,
      LAYOUT.battery.y - plateThickness,
      LAYOUT.battery.z,
    );

    const wrap = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, length),
      track(
        new THREE.MeshStandardMaterial({
          color: rng.chance(0.5) ? 0x1b1d22 : 0x22252b,
          roughness: 0.42,
          metalness: 0.12,
        }),
      ),
    );
    batteryGroup.add(wrap);

    // Strap.
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.004, 0.002, 0.012),
      track(new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.8 })),
    );
    strap.position.set(0, height / 2, 0.01);
    batteryGroup.add(strap);

    root.add(batteryGroup);
  }

  // --- Motor wires, as a hint of realism at the arm roots -------------------
  if (!isWhoop) {
    const wireMaterial = track(new THREE.MeshStandardMaterial({ color: 0xb02a2a, roughness: 0.6 }));
    const wireGeometry = new THREE.CylinderGeometry(0.0009, 0.0009, armLength * 0.5, 5);
    disposables.push(wireGeometry);
    for (const motor of build.motors) {
      const wire = new THREE.Mesh(wireGeometry, wireMaterial);
      wire.position.set(motor.position.x * 0.5, plateThickness * 0.9, motor.position.z * 0.5);
      wire.rotation.z = Math.PI / 2;
      wire.rotation.y = -Math.atan2(motor.position.z, motor.position.x);
      root.add(wire);
    }
  }

  const dispose = (): void => {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    for (const item of disposables) {
      if (!materials.includes(item as THREE.Material)) item.dispose();
    }
    for (const m of materials) m.dispose();
    PROP_MATERIAL_CACHE.clear();
  };

  return { root, props, camera: cameraGroup, battery: batteryGroup, materials, dispose };
}
