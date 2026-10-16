/**
 * Terrain and obstacle meshes.
 *
 * The terrain is a single indexed plane whose vertices are pushed to the
 * heightfield's actual sample, so what you fly over is exactly what the physics
 * collides with. Obstacles are instanced by kind because there are only eight
 * shapes and up to a hundred instances.
 */

import * as THREE from 'three';
import { createRng } from '../core/math/rng';
import type { Obstacle, Terrain } from '../core/terrain/generate';
import {
  barkTexture,
  concreteTexture,
  foliageTexture,
  groundTexture,
  metalSidingTexture,
} from './textures';

/** Vertex density. 192² is ~74k triangles — fine on a phone at 60 fps. */
const TERRAIN_SEGMENTS = 192;

export interface TerrainMesh {
  mesh: THREE.Mesh;
  obstacles: THREE.Group;
  dispose(): void;
}

export function buildTerrainMesh(terrain: Terrain): TerrainMesh {
  const { size } = terrain.config;
  const half = size / 2;
  const segments = TERRAIN_SEGMENTS;
  const vertexCount = (segments + 1) * (segments + 1);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  const heights = new Float32Array(vertexCount);

  for (let j = 0; j <= segments; j++) {
    for (let i = 0; i <= segments; i++) {
      const index = j * (segments + 1) + i;
      const x = (i / segments) * size - half;
      const z = (j / segments) * size - half;
      const y = terrain.sampleHeight(x, z);
      heights[index] = y;
      if (y < minHeight) minHeight = y;
      if (y > maxHeight) maxHeight = y;

      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
      uvs[index * 2] = i / segments;
      uvs[index * 2 + 1] = j / segments;
    }
  }

  // Normals from the sampled heights, so lighting matches the collision surface.
  const stride = segments + 1;
  for (let j = 0; j <= segments; j++) {
    for (let i = 0; i <= segments; i++) {
      const index = j * stride + i;
      const left = heights[j * stride + Math.max(i - 1, 0)];
      const right = heights[j * stride + Math.min(i + 1, segments)];
      const down = heights[Math.max(j - 1, 0) * stride + i];
      const up = heights[Math.min(j + 1, segments) * stride + i];
      const dx = right - left;
      const dz = up - down;
      const step = size / segments;
      const nx = -dx / (2 * step);
      const nz = -dz / (2 * step);
      const length = Math.hypot(nx, 1, nz);
      normals[index * 3] = nx / length;
      normals[index * 3 + 1] = 1 / length;
      normals[index * 3 + 2] = nz / length;
    }
  }

  const indices = new Uint32Array(segments * segments * 6);
  let cursor = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  const albedo = groundTexture(512, terrain.config.seed, minHeight, maxHeight);
  const material = new THREE.MeshStandardMaterial({
    map: albedo,
    roughness: 0.95,
    metalness: 0,
    vertexColors: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;

  const obstacles = buildObstacleGroup(terrain);

  return {
    mesh,
    obstacles,
    dispose(): void {
      geometry.dispose();
      material.dispose();
      albedo.dispose();
      disposeGroup(obstacles);
    },
  };
}

/** One InstancedMesh per obstacle kind — eight draw calls for a hundred objects. */
function buildObstacleGroup(terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  group.name = 'obstacles';
  const rng = createRng(`${terrain.config.seed}-obstacles`);

  const buckets = new Map<string, Obstacle[]>();
  for (const obstacle of terrain.obstacles) {
    const list = buckets.get(obstacle.kind);
    if (list) list.push(obstacle);
    else buckets.set(obstacle.kind, [obstacle]);
  }

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();

  for (const [kind, list] of buckets) {
    const shape = obstacleShape(kind, rng.next());
    const material = obstacleMaterial(kind);
    const instanced = new THREE.InstancedMesh(shape.geometry, material, list.length);
    instanced.name = `obstacles-${kind}`;
    instanced.castShadow = true;
    instanced.receiveShadow = true;

    list.forEach((obstacle, index) => {
      position.set(obstacle.position.x, obstacle.position.y, obstacle.position.z);
      quaternion.setFromEuler(new THREE.Euler(0, obstacle.rotation, 0));
      scale.set(obstacle.radius, obstacle.height, obstacle.radius);
      matrix.compose(position, quaternion, scale);
      instanced.setMatrixAt(index, matrix);
    });
    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
  }

  return group;
}

interface ObstacleShape {
  geometry: THREE.BufferGeometry;
}

function obstacleShape(kind: string, variant: number): ObstacleShape {
  switch (kind) {
    case 'pylon':
    case 'tower': {
      // A tapered lattice tower.
      const geometry = new THREE.CylinderGeometry(0.55, 1, 1, 6, 3, true);
      return { geometry };
    }
    case 'tree': {
      const geometry = new THREE.ConeGeometry(1, 1.35, 8, 2);
      geometry.translate(0, 0.675, 0);
      return { geometry };
    }
    case 'rock': {
      const geometry = new THREE.IcosahedronGeometry(1, 1);
      // Squash and roughen so it does not read as a ball.
      const position = geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        position.setXYZ(
          i,
          position.getX(i) * (0.8 + variant * 0.6),
          position.getY(i) * (0.6 + variant * 0.5),
          position.getZ(i) * (0.8 + (1 - variant) * 0.6),
        );
      }
      geometry.computeVertexNormals();
      return { geometry };
    }
    case 'fence': {
      const geometry = new THREE.BoxGeometry(2, 1, 0.06);
      return { geometry };
    }
    case 'gate': {
      const geometry = new THREE.TorusGeometry(1, 0.14, 8, 20);
      return { geometry };
    }
    case 'hangar': {
      const geometry = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false, 0, Math.PI);
      geometry.rotateZ(Math.PI / 2);
      geometry.rotateY(Math.PI / 2);
      return { geometry };
    }
    default: {
      const geometry = new THREE.BoxGeometry(2, 1, 2);
      return { geometry };
    }
  }
}

function obstacleMaterial(kind: string): THREE.Material {
  switch (kind) {
    case 'building':
      return new THREE.MeshStandardMaterial({
        map: concreteTexture({ size: 256, seed: 'buildings' }),
        roughness: 0.88,
        metalness: 0.02,
      });
    case 'hangar':
      return new THREE.MeshStandardMaterial({
        map: metalSidingTexture({ size: 256, seed: 'hangar' }),
        roughness: 0.55,
        metalness: 0.55,
      });
    case 'pylon':
    case 'tower':
    case 'fence':
      return new THREE.MeshStandardMaterial({ color: 0x6c737c, roughness: 0.5, metalness: 0.7 });
    case 'tree':
      return new THREE.MeshStandardMaterial({
        map: foliageTexture({ size: 128, seed: 'leaves' }),
        roughness: 0.92,
        transparent: true,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
      });
    case 'rock':
      return new THREE.MeshStandardMaterial({ color: 0x6f6c66, roughness: 0.96, flatShading: true });
    case 'gate':
      return new THREE.MeshStandardMaterial({ color: 0xe8542f, roughness: 0.6, emissive: 0x3a1206 });
    default:
      return new THREE.MeshStandardMaterial({ color: 0x7a7a78, roughness: 0.9 });
  }
}

/** Thin trunk instances so trees are not floating cones. */
export function buildTreeTrunks(terrain: Terrain): THREE.InstancedMesh | null {
  const trees = terrain.obstacles.filter((o) => o.kind === 'tree');
  if (trees.length === 0) return null;
  const bark = barkTexture({ size: 128, seed: 'bark' });
  const geometry = new THREE.CylinderGeometry(0.12, 0.18, 1, 6);
  geometry.translate(0, 0.5, 0);
  const material = new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 });
  const instanced = new THREE.InstancedMesh(geometry, material, trees.length);
  instanced.name = 'tree-trunks';
  const matrix = new THREE.Matrix4();
  trees.forEach((tree, index) => {
    matrix.compose(
      new THREE.Vector3(tree.position.x, tree.position.y, tree.position.z),
      new THREE.Quaternion(),
      new THREE.Vector3(tree.radius * 0.35, tree.height * 0.6, tree.radius * 0.35),
    );
    instanced.setMatrixAt(index, matrix);
  });
  instanced.instanceMatrix.needsUpdate = true;
  return instanced;
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh) {
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
}

/** Visual markers for the designated flying areas and the race gates. */
export function buildAreaMarkers(terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  group.name = 'areas';

  for (const area of terrain.areas) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(area.radius * 0.96, area.radius, 48),
      new THREE.MeshBasicMaterial({
        color: area.kind === 'course' ? 0x36d17a : 0x4aa8ff,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(area.center.x, terrain.sampleHeight(area.center.x, area.center.z) + 0.4, area.center.z);
    group.add(ring);
  }

  for (const area of terrain.areas) {
    for (const gate of area.gates) {
      const marker = new THREE.Mesh(
        new THREE.TorusGeometry(3.2, 0.22, 8, 24),
        new THREE.MeshStandardMaterial({ color: 0xff8a3d, emissive: 0xff5500, emissiveIntensity: 0.6 }),
      );
      marker.position.set(gate.x, gate.y, gate.z);
      marker.lookAt(gate.x, gate.y + 10, gate.z + 1);
      group.add(marker);
    }
  }
  return group;
}
