import type { PartSlot } from './spec';
import type { PartId } from './ids';

/**
 * A build is a bag of part ids. Nothing is derived here — `build/resolve.ts`
 * turns this into mass, inertia, electrical limits and mixer geometry.
 *
 * `slots` is intentionally mutable: the builder edits it in place as the pilot
 * swaps parts, and every change re-resolves the build.
 */
export interface BuildSpec {
  readonly id: string;
  name: string;
  description: string;
  slots: Partial<Record<PartSlot, PartId>>;
}

/**
 * Factory default builds. These are the app's real defaults — the app boots
 * into the first one and every panel falls back to it when a slot is empty.
 */
export const defaultBuilds: readonly BuildSpec[] = [
  {
    id: 'preset-freestyle-5-analog',
    name: 'Freestyle 5" (Analog)',
    description:
      'Durable 5" freestyle quad on analog video. 6S, 35°/30° props, reliable ELRS control.',
    slots: {
      frame: 'frame-geprc-mark5-hd',
      motor: 'motor-gemini-f421-1750kv',
      propA: 'prop-hq-r38',
      propB: 'prop-hq-r38',
      stack: 'stack-speedybee-f405-v4-60a',
      vtx: 'vtx-foxeer-predator-v5-plus',
      camera: 'cam-foxeer-predator-v5',
      lens: 'lens-foxeer-1-8mm-m8',
      rx: 'rx-elrs-ep2-24',
      tx: 'tx-radiomaster-tx16s-mkii-elrs',
      antenna: 'ant-mjkay-58-dual-dipole',
      battery1: 'batt-tattu-rline-v5-6s1300-100c',
    },
  },
  {
    id: 'preset-race-5-digital-o3',
    name: 'Race 5" (DJI O3)',
    description:
      'Low-latency 6S race build on DJI O3. Lighter props and higher KV for corner speed.',
    slots: {
      frame: 'frame-impulse-apex-evo-5',
      motor: 'motor-iflight-xing2-2207-1950kv',
      propA: 'prop-gemfan-hurricane-51466',
      propB: 'prop-gemfan-hurricane-51466',
      stack: 'stack-speedybee-f7-v3-60a',
      vtx: 'vtx-dji-o3-air-unit',
      rx: 'rx-elrs-ep2-24',
      tx: 'tx-radiomaster-tx16s-mkii-elrs',
      antenna: 'ant-truerc-xair-mk2',
      battery1: 'batt-gnb-6s1300-130c',
    },
  },
  {
    id: 'preset-longrange-7',
    name: 'Long Range 7"',
    description:
      '7" efficiency build for open terrain. Big motors on low-KV, cruise-efficient props.',
    slots: {
      frame: 'frame-tbs-source-one-7',
      motor: 'motor-foxeer-vortex-2812-900kv',
      propA: 'prop-hq-7403',
      propB: 'prop-hq-7403',
      stack: 'stack-speedybee-f7-v3-60a',
      vtx: 'vtx-walksnail-avatar-hd',
      rx: 'rx-elrs-nano-900',
      tx: 'tx-radiomaster-tx16s-mkii-elrs-900',
      antenna: 'ant-truerc-xair-mk2',
      battery1: 'batt-tattu-rline-v5-6s2200-100c',
    },
  },
  {
    id: 'preset-whoop-3',
    name: 'Whoop 3"',
    description: 'Sub-250 g indoor whoop. 3S, 0806 motors, ducted 3" props.',
    slots: {
      frame: 'frame-iflight-nazgul-evo',
      motor: 'motor-se0702-17000kv',
      propA: 'prop-gemfan-3115',
      propB: 'prop-gemfan-3115',
      stack: 'stack-foxeer-reaper-mini-35a',
      vtx: 'vtx-foxeer-predator-mini',
      camera: 'cam-foxeer-reaper-mini',
      lens: 'lens-foxeer-2-1mm-m8',
      rx: 'rx-jumper-elrs-ep1-24',
      tx: 'tx-radiomaster-boxer-elrs',
      antenna: 'ant-foxeer-58-dipole',
      battery1: 'batt-lipo-3s850-60c',
    },
  },
  {
    id: 'preset-cinewhoop-6',
    name: 'Cinewhoop 6"',
    description: '4S protected cinema build for scenic flying. O3 camera, low-KV 2802 motors.',
    slots: {
      frame: 'frame-geprc-meteor-65',
      motor: 'motor-se2802-5-1500kv',
      propA: 'prop-gemfan-6130',
      propB: 'prop-gemfan-6130',
      stack: 'stack-tmotor-f7-pro',
      vtx: 'vtx-dji-o3-air-unit-pro',
      rx: 'rx-elrs-ep2-24',
      tx: 'tx-radiomaster-zorro-elrs',
      antenna: 'ant-truerc-xair-mk2',
      battery1: 'batt-tattu-rline-v5-4s1300-110c',
    },
  },
  {
    id: 'preset-cinewhoop-35',
    name: 'Cinewhoop 3.5"',
    description: 'Compact cinematic whoop. Analog video, 4S, 1404 motors.',
    slots: {
      frame: 'frame-iflight-protek360',
      motor: 'motor-iflight-xing-1404-4600kv',
      propA: 'prop-hq-3533',
      propB: 'prop-hq-3533',
      stack: 'stack-speedybee-f405-mini-35a',
      vtx: 'vtx-foxeer-predator-mini',
      camera: 'cam-foxeer-reaper-mini',
      lens: 'lens-foxeer-2-1mm-m8',
      rx: 'rx-jumper-elrs-ep1-24',
      tx: 'tx-radiomaster-boxer-elrs',
      antenna: 'ant-foxeer-58-dipole',
      battery1: 'batt-lipo-4s850-100c',
    },
  },
];

export const DEFAULT_BUILD_ID = defaultBuilds[0].id;

export const findBuild = (id: string): BuildSpec =>
  defaultBuilds.find((b) => b.id === id) ?? defaultBuilds[0];

/** An empty build shell — every slot null, used when the user starts from scratch. */
export const emptyBuild = (): BuildSpec => ({ id: 'custom', name: 'Custom Build', description: '', slots: {} });
