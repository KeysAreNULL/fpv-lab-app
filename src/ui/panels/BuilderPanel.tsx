import { useMemo, useState } from 'react';
import {
  ALL_PARTS,
  findPart,
  partsOfCategory,
  partLabel,
  searchParts,
  SLOT_CATEGORY,
  type Part,
  type PartCategory,
  type PartId,
  type PartSlot,
} from '../../core/parts';
import { defaultBuilds } from '../../core/parts/presets';
import { validateBuild, type BuildIssue } from '../../core/build/rules';
import { resolveBuild } from '../../core/build/resolve';
import { actions, useStore } from '../../state/store';
import { Bar, Card, PanelHead, Select, Stat, fmt, fmtDistance } from '../components';

/** Slot order in the builder, which is the order a pilot actually assembles. */
const SLOT_ORDER: { slot: PartSlot; label: string }[] = [
  { slot: 'frame', label: 'Frame' },
  { slot: 'motor', label: 'Motor' },
  { slot: 'propA', label: 'Prop A' },
  { slot: 'propB', label: 'Prop B' },
  { slot: 'stack', label: 'Stack' },
  { slot: 'fc', label: 'Flight FC' },
  { slot: 'esc', label: 'ESC' },
  { slot: 'vtx', label: 'VTX' },
  { slot: 'camera', label: 'Camera' },
  { slot: 'lens', label: 'Lens' },
  { slot: 'antenna', label: 'Antenna' },
  { slot: 'rx', label: 'Receiver' },
  { slot: 'tx', label: 'Transmitter' },
  { slot: 'gps', label: 'GPS' },
  { slot: 'battery1', label: 'Battery' },
];

function partSummary(part: Part): string {
  switch (part.category) {
    case 'frame':
      return `${part.frameClass.replace('inch', '')}" · ${part.motorMount} motors · ${part.massGrams} g`;
    case 'motor':
      return `${part.statorSize} · ${part.kvRpmPerVolt}KV · ${part.maxThrustGrams} g · ${part.massGrams} g`;
    case 'prop':
      return `${part.diameterInches}" × ${part.pitchInches}" × ${part.bladeCount} · ${part.massGrams} g`;
    case 'stack':
      return `${part.mcu} · ${part.maxContinuousAmps} A · ${part.massGrams} g`;
    case 'fc':
      return `${part.mcu} · ${part.gyro} · ${part.massGrams} g`;
    case 'esc':
      return `${part.protocol} · ${part.maxContinuousAmps} A · ${part.pwmKhz} kHz`;
    case 'vtx':
      return `${part.linkType} · ${part.frequencyBandMhz} MHz · ${part.outputMilliwatts} mW`;
    case 'camera':
      return `${part.tvl} TVL · ${part.sensor} · ${part.widthMm} mm`;
    case 'lens':
      return `${part.focalLengthMm} mm · ${part.apertureFStop} f/${part.mount}`;
    case 'rx':
      return `${part.protocol} · ${part.frequencyBandMhz} MHz · ${part.txPowerDbm} dBm`;
    case 'tx':
      return `${part.protocol} · ${part.channels} ch · ${part.massGrams} g`;
    case 'antenna':
      return `${part.bandMhz} MHz · ${part.gainDbi} dBi · ${part.polarization}`;
    case 'gps':
      return `${part.chipset} · ${part.updateRateHz} Hz`;
    case 'battery':
      return `${part.cells}S ${part.capacityMah} mAh · ${part.cRating}C · ${part.packResistanceMilliOhm} mΩ`;
  }
}

const ISSUE_GLYPH: Record<BuildIssue['level'], string> = {
  error: '✕',
  warning: '!',
  info: 'i',
};

export function BuilderPanel(): JSX.Element {
  const build = useStore((s) => s.build);
  const activeSlot = useStore((s) => s.slot);
  const [query, setQuery] = useState('');

  const issues = useMemo(() => validateBuild(build), [build]);
  const resolved = useMemo(() => resolveBuild(build), [build]);
  const category = SLOT_CATEGORY[activeSlot];

  // A digital VTX carries its own camera, so hide the camera slot rather than
  // offering a choice that will only produce an error.
  const vtxIsDigital = findPart(build.slots.vtx)?.category === 'vtx' &&
    (findPart(build.slots.vtx) as { linkType?: string } | null)?.linkType === 'digital';
  const visibleSlots = vtxIsDigital
    ? SLOT_ORDER.filter((s) => s.slot !== 'camera' && s.slot !== 'lens')
    : SLOT_ORDER;

  const options = useMemo(() => {
    const found = searchParts(query, category as PartCategory);
    return found.length > 0 ? found : partsOfCategory(category as PartCategory);
  }, [query, category]);

  const selectedId = build.slots[activeSlot];

  return (
    <div className="panel wide">
      <PanelHead title="Builder">
        <select
          value={build.id}
          onChange={(e) => actions.loadPreset(e.target.value)}
          style={{ maxWidth: 220 }}
        >
          {defaultBuilds.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={() => actions.setPart(activeSlot, null)}>
          Clear slot
        </button>
      </PanelHead>

      <div className="slot-list">
        {visibleSlots.map(({ slot, label }) => (
          <button
            key={slot}
            className="slot"
            data-active={slot === activeSlot}
            data-filled={Boolean(build.slots[slot])}
            onClick={() => actions.setSlot(slot)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid">
        <Card title={`${SLOT_CATEGORY[activeSlot]} options`}>
          <input
            type="text"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div className="part-list">
            {options.map((part) => (
              <button
                key={part.id}
                className="part"
                data-selected={part.id === selectedId}
                onClick={() => actions.setPart(activeSlot, part.id as PartId)}
              >
                <span className="part-name">
                  {part.brand} {part.name}
                </span>
                <span className="part-price">${part.priceUsd.toFixed(part.priceUsd % 1 ? 2 : 0)}</span>
                <span className="part-meta">
                  {partSummary(part)}
                  {part.specSource === 'community-measured' ? ' · measured' : ''}
                </span>
              </button>
            ))}
          </div>
        </Card>

        <Card title="Airframe">
          <div className="stat-grid">
            <Stat label="All-up" value={`${(resolved.auwKg * 1000).toFixed(0)} g`} />
            <Stat label="Cells" value={resolved.electrical.cells ? `${resolved.electrical.cells}S` : '—'} />
            <Stat
              label="T/W"
              value={fmt(resolved.electrical.thrustToWeight, 2)}
              tone={resolved.electrical.thrustToWeight < 1.5 ? 'warn' : 'good'}
            />
            <Stat label="Price" value={`$${resolved.totalPriceUsd.toFixed(0)}`} />
            <Stat
              label="Hover"
              value={`${resolved.electrical.hoverAmpsTotal.toFixed(0)} A`}
              tone={
                resolved.battery && resolved.electrical.hoverAmpsTotal > resolved.battery.burstDischargeAmps
                  ? 'warn'
                  : 'good'
              }
            />
            <Stat label="Hover RPM" value={resolved.electrical.hoverRpmPerMotor.toFixed(0)} />
            <Stat label="Wheelbase" value={fmt(resolved.wheelbaseM * 1000, 0, ' mm')} />
            <Stat label="Prop" value={fmt(resolved.propModel.diameterM * 1000, 0, ' mm')} />
          </div>
        </Card>

        <Card title="Mass breakdown">
          <div className="part-list">
            {resolved.breakdown.map((entry) => (
              <div key={`${entry.slot}-${entry.label}`} className="part" style={{ cursor: 'default' }}>
                <span className="part-name">{entry.label}</span>
                <span className="part-price">{entry.massGrams.toFixed(1)} g</span>
                <span className="part-meta">
                  <Bar value={entry.massGrams / Math.max(resolved.auwKg * 1000, 1)} />
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Video & control">
          <div className="stat-grid">
            <Stat
              label="Video"
              value={resolved.video.linkType === 'digital' ? 'Digital' : 'Analog'}
              tone="good"
            />
            <Stat label="Latency" value={`${resolved.video.latencyMs.toFixed(0)} ms`} />
            <Stat label="TVL" value={resolved.video.cameraTvl.toFixed(0)} />
            <Stat label="Lens" value={`${((resolved.video.lensFovRad * 180) / Math.PI).toFixed(0)}°`} />
            <Stat label="Protocol" value={resolved.control.protocol} />
            <Stat label="Band" value={`${(resolved.control.frequencyHz / 1e6).toFixed(0)} MHz`} />
            <Stat label="Refresh" value={`${resolved.control.refreshRateHz} Hz`} />
            <Stat
              label="Range"
              value={fmtDistance(estimatedRange(resolved.control.frequencyHz, resolved.video.gainDbi, resolved.video.outputMilliwatts))}
            />
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 10 }}>
        {issues.length === 0 ? (
          <div className="issue" data-level="info">
            <span>✓</span>
            <span>
              Everything fits. {partLabel(build.slots.frame)} with{' '}
              {partLabel(build.slots.motor)} and {partLabel(build.slots.battery1)}.
            </span>
          </div>
        ) : (
          issues.map((issue, index) => (
            <div key={index} className="issue" data-level={issue.level}>
              <span aria-hidden>{ISSUE_GLYPH[issue.level]}</span>
              <span>
                {issue.message}
                {issue.slot ? (
                  <>
                    {' '}
                    <button
                      className="btn small"
                      style={{ marginLeft: 6, minHeight: 26 }}
                      onClick={() => actions.setSlot(issue.slot as PartSlot)}
                    >
                      Fix
                    </button>
                  </>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <Select
          label="Camera tilt"
          value={'0'}
          options={[{ value: '0', label: '25° up (FPV standard)' }]}
          onChange={() => undefined}
        />
      </div>
    </div>
  );
}

/**
 * Rough line-of-sight range for the fitted video link, used for the builder's
 * range readout. Not a substitute for the real link budget, but it scales the
 * right things: power, gain and band.
 */
function estimatedRange(frequencyHz: number, gainDbi: number, milliwatts: number): number {
  const txDbm = 10 * Math.log10(Math.max(milliwatts, 1));
  const marginDb = 20; // workable video margin
  const budget = txDbm + gainDbi + 3 - (-105) - marginDb;
  // FSPL = 20log10(d) + 20log10(f) - 147.55, solved for d.
  return Math.pow(10, (budget - 20 * Math.log10(frequencyHz) + 147.55) / 20);
}

export { ALL_PARTS };
