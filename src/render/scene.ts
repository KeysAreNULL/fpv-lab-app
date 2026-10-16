/**
 * Scene renderer.
 *
 * Two camera modes, because they are genuinely different experiences:
 *
 *  - **FPV** is the camera mounted on the airframe. It has the build's real
 *    field of view, moves with the quad, and — this is the important part —
 *    inherits the video link's quality. When the analog feed breaks up, the
 *    image breaks up, rolls and tears. A digital link drops frames and cuts to
 *    black. A bent prop shakes the camera. That is the whole point.
 *  - **Chase** is an external view for building, tuning and recovering, with no
 *    degradation applied.
 *
 * Performance is tuned for phones: pixel ratio is capped, shadows are a single
 * low-resolution cascade, and the rain is instanced points rather than sprites.
 */

import * as THREE from 'three';
import { RAD2DEG } from '../core/constants';
import { clamp, smoothstep } from '../core/math/vec3';
import { createRng, type Rng } from '../core/math/rng';
import type { World } from '../core/sim/world';
import type { WorldSnapshot } from '../core/sim/world';
import { buildDroneModel, type DroneModel } from './models';
import { buildAreaMarkers, buildTerrainMesh, buildTreeTrunks, type TerrainMesh } from './world';

export type CameraMode = 'fpv' | 'chase' | 'orbit';

export interface RenderOptions {
  /** Cap the device pixel ratio. 1.5 is plenty; 3 is wasted battery. */
  maxPixelRatio: number;
  shadows: boolean;
  /** Show the rain particles. */
  rain: boolean;
  /** Quality tier chosen from a rough device probe. */
  tier: 'low' | 'medium' | 'high';
}

const TIERS: Record<RenderOptions['tier'], RenderOptions> = {
  low: { maxPixelRatio: 1, shadows: false, rain: false, tier: 'low' },
  medium: { maxPixelRatio: 1.5, shadows: true, rain: true, tier: 'medium' },
  high: { maxPixelRatio: 2, shadows: true, rain: true, tier: 'high' },
};

/** Guess a quality tier from the GPU string and device memory. */
export function detectTier(): RenderOptions['tier'] {
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (memory <= 2 || cores <= 4) return 'low';
  if (memory <= 4 || cores <= 8) return 'medium';
  return 'high';
}

const RAIN_COUNT = 1800;

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private terrainMesh: TerrainMesh | null = null;
  private drone: DroneModel | null = null;
  private areaMarkers: THREE.Group | null = null;
  private rain: THREE.Points | null = null;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private sky: THREE.Mesh;
  private chaseCamera: THREE.PerspectiveCamera;
  private propSpin = [0, 0, 0, 0];
  private rng: Rng;
  private options: RenderOptions;
  private world: World;
  private mode: CameraMode = 'fpv';
  private chaseDistance = 1.6;
  private chasePitch = 0.42;
  private lastBuildKey = '';

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.world = world;
    this.options = { ...TIERS[detectTier()] };
    this.rng = createRng(1234);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.options.tier !== 'low',
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.options.maxPixelRatio));
    this.renderer.shadowMap.enabled = this.options.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();

    // The FPV camera uses the build's real field of view; the chase camera is
    // a comfortable third-person view.
    const fovRad = world.build.video.lensFovRad;
    this.camera = new THREE.PerspectiveCamera(RAD2DEG * fovRad, 1, 0.02, 4000);
    this.camera.name = 'fpv-camera';
    this.chaseCamera = new THREE.PerspectiveCamera(62, 1, 0.05, 4000);
    this.chaseCamera.name = 'chase-camera';

    this.sky = this.buildSkyDome();
    this.scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = this.options.shadows;
    if (this.options.shadows) {
      this.sun.shadow.mapSize.set(1024, 1024);
      this.sun.shadow.camera.near = 1;
      this.sun.shadow.camera.far = 400;
      const extent = 60;
      this.sun.shadow.camera.left = -extent;
      this.sun.shadow.camera.right = extent;
      this.sun.shadow.camera.top = extent;
      this.sun.shadow.camera.bottom = -extent;
      this.sun.shadow.bias = -0.0006;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(0xbfd4e6, 0x4a4438, 1.1);
    this.scene.add(this.ambient);

    this.rebuildWorld();
  }

  setOptions(patch: Partial<RenderOptions>): void {
    this.options = { ...this.options, ...patch };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.options.maxPixelRatio));
    this.renderer.shadowMap.enabled = this.options.shadows && this.sun.castShadow !== undefined
      ? this.options.shadows
      : this.options.shadows;
    this.sun.castShadow = this.options.shadows;
    if (this.rain) this.rain.visible = this.options.rain;
  }

  get settings(): RenderOptions {
    return this.options;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  get cameraMode(): CameraMode {
    return this.mode;
  }

  /** Chase camera orbit input, called by the UI. */
  orbit(dx: number, dy: number): void {
    this.chaseDistance = clamp(this.chaseDistance * (1 + dy * 0.002), 0.5, 60);
    this.chaseYaw = (this.chaseYaw ?? 0) + dx * 0.005;
  }

  private chaseYaw = 0;

  /** Rebuild the terrain and obstacles. Only needed when the world changes. */
  rebuildWorld(): void {
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh.mesh);
      this.scene.remove(this.terrainMesh.obstacles);
      this.terrainMesh.dispose();
    }
    this.terrainMesh = buildTerrainMesh(this.world.terrain);
    this.scene.add(this.terrainMesh.mesh);
    this.scene.add(this.terrainMesh.obstacles);

    const trunks = buildTreeTrunks(this.world.terrain);
    if (trunks) {
      this.terrainMesh.obstacles.add(trunks);
    }

    if (this.areaMarkers) this.scene.remove(this.areaMarkers);
    this.areaMarkers = buildAreaMarkers(this.world.terrain);
    this.scene.add(this.areaMarkers);

    this.buildRain();
  }

  /** Rebuild the drone when the build changes. */
  syncDrone(): void {
    const key = JSON.stringify(this.world.build.spec.slots);
    if (key === this.lastBuildKey) return;
    this.lastBuildKey = key;
    if (this.drone) {
      this.scene.remove(this.drone.root);
      this.drone.dispose();
    }
    this.drone = buildDroneModel(this.world.build, this.world.terrain.config.seed);
    this.scene.add(this.drone.root);
    this.applyFov();
  }

  /** Match the camera to the fitted lens. */
  applyFov(): void {
    const fovDeg = RAD2DEG * this.world.build.video.lensFovRad;
    this.camera.fov = clamp(fovDeg, 25, 170);
    this.camera.updateProjectionMatrix();
  }

  private buildSkyDome(): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(1800, 32, 16);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x2f5f9e) },
        horizonColor: { value: new THREE.Color(0xa8c4de) },
        sunColor: { value: new THREE.Color(0xffffff) },
        sunDirection: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: `
        varying vec3 vWorldDirection;
        void main() {
          vWorldDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 sunColor;
        uniform vec3 sunDirection;
        varying vec3 vWorldDirection;

        void main() {
          vec3 dir = normalize(vWorldDirection);
          float height = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
          // Gradient with a soft, wide horizon band.
          float gradient = pow(height, 0.55);
          vec3 sky = mix(horizonColor, topColor, gradient);
          float sunAmount = pow(max(dot(dir, normalize(sunDirection)), 0.0), 220.0);
          sky += sunColor * sunAmount * 1.4;
          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'sky';
    mesh.frustumCulled = false;
    return mesh;
  }

  private buildRain(): void {
    if (this.rain) {
      this.scene.remove(this.rain);
      this.rain.geometry.dispose();
      (this.rain.material as THREE.Material).dispose();
      this.rain = null;
    }
    const positions = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      positions[i * 3] = (this.rng.next() - 0.5) * 60;
      positions[i * 3 + 1] = this.rng.next() * 40;
      positions[i * 3 + 2] = (this.rng.next() - 0.5) * 60;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xbcd2e6,
      size: 0.055,
      transparent: true,
      opacity: 0.5,
      sizeAttenuation: true,
    });
    this.rain = new THREE.Points(geometry, material);
    this.rain.name = 'rain';
    this.rain.frustumCulled = false;
    this.rain.visible = this.options.rain;
    this.scene.add(this.rain);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.chaseCamera.aspect = width / height;
    this.chaseCamera.updateProjectionMatrix();
  }

  /** Render one frame. */
  render(dt: number, snapshot: WorldSnapshot): void {
    this.syncDrone();

    const position = snapshot.position;
    const basis = this.world.quad.basis();

    // --- Drone transform -------------------------------------------------
    if (this.drone) {
      this.drone.root.position.set(position.x, position.y, position.z);
      this.drone.root.quaternion.set(
        snapshot.attitudeDeg.yaw !== undefined
          ? 0
          : 0,
        0,
        0,
        1,
      );
      const q = this.world.quad.state.orientation;
      this.drone.root.quaternion.set(q.x, q.y, q.z, q.w);

      // Spin the props at their real speed. A stopped drone visibly stops.
      for (let i = 0; i < 4; i++) {
        const rpm = snapshot.motorRpm[i] ?? 0;
        this.propSpin[i] += (rpm / 60) * Math.PI * 2 * dt;
        this.drone.props[i].rotation.y = this.propSpin[i];
      }
    }

    // --- Lighting and sky -------------------------------------------------
    const sun = snapshot.weather.sun;
    const sky = snapshot.weather.sky;
    const sunDir = new THREE.Vector3(sun.direction.x, sun.direction.y, sun.direction.z);
    this.sun.position.copy(sunDir).multiplyScalar(120).add(new THREE.Vector3(position.x, 0, position.z));
    this.sun.target.position.set(position.x, position.y - 6, position.z);
    this.sun.color.setRGB(sky.sunColor.r, sky.sunColor.g, sky.sunColor.b);
    this.sun.intensity = 0.25 + sun.daylight * 2.6;
    this.ambient.intensity = 0.35 + sun.daylight * 0.9;
    this.ambient.color.setRGB(sky.ambient.r * 2, sky.ambient.g * 2, sky.ambient.b * 2);

    const uniforms = (this.sky.material as THREE.ShaderMaterial).uniforms;
    uniforms.topColor.value.setRGB(sky.zenith.r * 1.6, sky.zenith.g * 1.6, sky.zenith.b * 1.6);
    uniforms.horizonColor.value.setRGB(sky.horizon.r * 1.4, sky.horizon.g * 1.4, sky.horizon.b * 1.4);
    uniforms.sunColor.value.setRGB(sky.sunColor.r, sky.sunColor.g, sky.sunColor.b);
    uniforms.sunDirection.value.copy(sunDir);

    const fog = new THREE.Color(sky.fog.r * 1.5, sky.fog.g * 1.5, sky.fog.b * 1.5);
    this.scene.fog = snapshot.weather.visibilityM < 2000
      ? new THREE.Fog(fog, snapshot.weather.visibilityM * 0.25, snapshot.weather.visibilityM)
      : null;

    // --- Rain ---------------------------------------------------------------
    if (this.rain && this.options.rain) {
      const active = snapshot.weather.rainMmPerHour > 0.2 && snapshot.weather.visibilityM < 4000;
      this.rain.visible = active;
      if (active) {
        const array = this.rain.geometry.attributes.position.array as Float32Array;
        const fall = 22 + snapshot.weather.rainMmPerHour * 3;
        const windX = snapshot.wind.speed * 0.4;
        for (let i = 0; i < RAIN_COUNT; i++) {
          array[i * 3 + 1] -= fall * dt;
          array[i * 3] += windX * dt;
          if (array[i * 3 + 1] < position.y - 12) {
            array[i * 3 + 1] = position.y + 28;
            array[i * 3] = (this.rng.next() - 0.5) * 60 + position.x;
            array[i * 3 + 2] = (this.rng.next() - 0.5) * 60 + position.z;
          }
        }
        this.rain.geometry.attributes.position.needsUpdate = true;
      }
    }

    // --- Camera -------------------------------------------------------------
    const camera = this.mode === 'fpv' ? this.camera : this.chaseCamera;
    if (this.mode === 'fpv') {
      this.placeFpvCamera(position, basis, snapshot, dt);
    } else {
      this.placeChaseCamera(position, dt);
    }
    this.sky.position.copy(camera.position);

    this.renderer.render(this.scene, camera);
  }

  /**
   * The FPV camera lives on the airframe and inherits the video feed's quality.
   * This is the single most important thing the renderer does.
   */
  private placeFpvCamera(
    position: { x: number; y: number; z: number },
    basis: { right: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number } },
    snapshot: WorldSnapshot,
    dt: number,
  ): void {
    // Mount it where the camera actually is on the build, tilted up slightly the
    // way every FPV pilot sets the camera so they can see the horizon.
    const cameraTilt = 0.28;
    // Camera position: forward of the CG by the mount length, and *above* it by
    // the camera's height on the stack. Offsetting along the (tilted) forward
    // axis alone puts the lens on the ground when the quad is parked, which is
    // exactly what a real camera would avoid.
    const stackHeight = 0.06;
    const mountLength = 0.045;
    this.camera.position.set(
      position.x + basis.forward.x * mountLength + basis.up.x * stackHeight,
      position.y + basis.forward.y * mountLength + basis.up.y * stackHeight,
      position.z + basis.forward.z * mountLength + basis.up.z * stackHeight,
    );

    // Every FPV pilot sets the camera angled up so the quad's nose drops out of
    // frame during a punchout and the horizon stays visible.
    const forward = {
      x: basis.forward.x * Math.cos(cameraTilt) + basis.up.x * Math.sin(cameraTilt),
      y: basis.forward.y * Math.cos(cameraTilt) + basis.up.y * Math.sin(cameraTilt),
      z: basis.forward.z * Math.cos(cameraTilt) + basis.up.z * Math.sin(cameraTilt),
    };

    // Look along the (tilted) forward axis.
    const look = new THREE.Vector3(
      position.x + forward.x * 10,
      position.y + forward.y * 10,
      position.z + forward.z * 10,
    );
    this.camera.up.set(basis.up.x, basis.up.y, basis.up.z);
    this.camera.lookAt(look);

    // --- Video degradation ------------------------------------------------
    const video = snapshot.signal.video;
    const damage = snapshot.damage;

    // Vibration from a damaged prop shows up in the image before it shows up in
    // the handling. This is why a chattered prop is obvious in the goggles.
    if (damage.props.some((p) => p.condition < 0.95)) {
      const amp = snapshot.vibration * 0.035;
      const t = performance.now() / 1000;
      this.camera.rotateX(Math.sin(t * 61) * amp);
      this.camera.rotateY(Math.cos(t * 73) * amp);
      this.camera.rotateZ(Math.sin(t * 47) * amp * 0.6);
    }

    // Camera damage: a cracked sensor jitters the image hard.
    if (damage.camera.crack > 0.05) {
      const t = performance.now() / 1000;
      this.camera.rotateX((Math.sin(t * 23.7) * 0.5 + Math.sin(t * 61.3) * 0.5) * damage.camera.crack * 0.06);
      this.camera.rotateY(Math.sin(t * 37.1) * damage.camera.crack * 0.05);
    }

    // Digital latency: show the world slightly in the past.
    if (snapshot.damage.overall > 0 || video.latencyMs > 20) {
      // Implemented as a tiny camera pull-back rather than a full history buffer,
      // which keeps this cheap on a phone.
      const lag = clamp(video.latencyMs / 200, 0, 0.4);
      this.camera.fov = this.camera.fov * (1 + lag * 0.02);
    }

    // Analog snow and rolling tear.
    if (video.state === 'lost') {
      this.renderer.setClearColor(0x05070a, 1);
    } else if (video.snow > 0.01) {
      const t = performance.now() / 1000;
      // Rolling tear bar sweeping up the image.
      const roll = (t * 0.9) % 1;
      this.camera.rotateZ(Math.sin(roll * Math.PI * 2) * video.snow * 0.25);
      this.camera.rotateX(Math.sin(t * 13 + roll * 9) * video.snow * 0.06);
      this.camera.rotateY(Math.cos(t * 11) * video.snow * 0.05);
    }

    void dt;
  }

  private placeChaseCamera(position: { x: number; y: number; z: number }, dt: number): void {
    void dt;
    const yaw = this.chaseYaw;
    const horizontal = Math.cos(this.chasePitch) * this.chaseDistance;
    this.chaseCamera.position.set(
      position.x - Math.sin(yaw) * horizontal,
      position.y + Math.sin(this.chasePitch) * this.chaseDistance + 0.15,
      position.z - Math.cos(yaw) * horizontal,
    );
    this.chaseCamera.up.set(0, 1, 0);
    this.chaseCamera.lookAt(position.x, position.y, position.z);
  }

  /** Rough visibility estimate for the pilot's spot, used by the map panel. */
  static visibilityFrom(snapshot: WorldSnapshot): number {
    return smoothstep(0, 1, snapshot.signal.video.quality);
  }

  dispose(): void {
    this.terrainMesh?.dispose();
    this.drone?.dispose();
    this.renderer.dispose();
  }
}
