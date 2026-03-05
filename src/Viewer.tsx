import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type VivModule = typeof import('@hms-dbmi/viv');

interface VivChannel {
  channelsVisible: boolean;
  color: string;
  label: string;
  window: { start: number; end: number; min?: number; max?: number };
}
interface VivMetadata {
  omero: {
    channels: VivChannel[];
    rdefs: { defaultT?: number; defaultZ?: number };
  };
}

const FALLBACK_COLORS: [number, number, number][] = [
  [255, 128, 0], [0, 200, 100], [0, 128, 255],
  [255, 220, 0], [220, 0, 255], [0, 255, 220],
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const GLASS: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(30,30,30,0.55)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
};

const VERSION = '1.4.3';

const BTN_SIZE = 28;
const INSET = 6;
const TRANSITION = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';

const PANEL_MIN_W = 100;
const PANEL_MIN_H = 120;
const PANEL_MAX_W = 220;
const PANEL_MAX_H = 260;
const PANEL_MARGIN = 20;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// Inject the spin keyframes once into the document
const SPIN_KEYFRAMES_ID = 'microatlas-spin';
function ensureSpinKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SPIN_KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = SPIN_KEYFRAMES_ID;
  style.textContent = `@keyframes ${SPIN_KEYFRAMES_ID}{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`;
  document.head.appendChild(style);
}

/** LRU in-memory cache wrapping a zarr HTTPStore. Keeps fetched chunks in a
 *  Map so revisiting a Z/T slice is instant instead of re-fetching from S3. */
class CachingStore {
  private cache = new Map<string, ArrayBuffer>();
  private order: string[] = [];
  private bytes = 0;
  private prefetchController: AbortController | null = null;
  /** Timestamp of the most recent getItem call (hit or miss). */
  private lastGetItemTime = 0;
  /** Count of in-flight fetches (cache misses, any caller). */
  private pendingFetches = 0;
  private settledResolvers: (() => void)[] = [];
  constructor(private inner: any, private maxBytes = 256 * 1024 * 1024) {}

  /** Resolves once no getItem calls have occurred for `quietMs`,
   *  then waits for any remaining in-flight fetches to complete.
   *  During playback prefetch is suppressed, so only display requests
   *  flow through — making this an accurate measure of tile loading.
   *  Safety timeout at `timeoutMs` to prevent infinite hangs. */
  waitForIdle(quietMs: number, timeoutMs = 10000): Promise<void> {
    // Reset so we always observe at least one full quiet period.
    this.lastGetItemTime = performance.now();
    return new Promise(resolve => {
      const deadline = performance.now() + timeoutMs;
      const check = () => {
        const since = performance.now() - this.lastGetItemTime;
        if (since >= quietMs) {
          // Quiet period elapsed — if fetches still in flight, wait for them
          if (this.pendingFetches > 0) {
            this.settledResolvers.push(resolve);
          } else {
            resolve();
          }
          return;
        }
        if (performance.now() >= deadline) { resolve(); return; }
        setTimeout(check, Math.max(1, quietMs - since));
      };
      setTimeout(check, quietMs);
    });
  }

  async getItem(item: string, opts?: any): Promise<ArrayBuffer> {
    this.lastGetItemTime = performance.now();

    const hit = this.cache.get(item);
    if (hit) {
      // Move to end (most-recently-used)
      const i = this.order.indexOf(item);
      if (i >= 0) { this.order.splice(i, 1); this.order.push(item); }
      return hit;
    }
    this.pendingFetches++;
    try {
      const buf: ArrayBuffer = await this.inner.getItem(item, opts);
      this.cache.set(item, buf);
      this.order.push(item);
      this.bytes += buf.byteLength;
      while (this.bytes > this.maxBytes && this.order.length > 0) {
        const old = this.order.shift()!;
        const b = this.cache.get(old);
        if (b) { this.bytes -= b.byteLength; this.cache.delete(old); }
      }
      return buf;
    } finally {
      this.pendingFetches--;
      if (this.pendingFetches === 0) {
        const cbs = this.settledResolvers.splice(0);
        cbs.forEach(cb => cb());
      }
    }
  }

  /** Cancel all in-flight prefetch requests so display requests get priority. */
  cancelPrefetch() {
    if (this.prefetchController) {
      this.prefetchController.abort();
      this.prefetchController = null;
    }
  }

  /** Background-fetch chunks for adjacent Z/T slices so scrubbing feels instant.
   *  Scans cached chunk paths matching the current position, swaps the Z or T
   *  coordinate to nearby values, and fetches any that aren't already cached.
   *  All prefetch requests are abortable via cancelPrefetch(). */
  prefetchAdjacent(opts: {
    zDimIdx: number; tDimIdx: number;
    currentZ: number; currentT: number;
    maxZ: number; maxT: number;
    numDims: number; dimSep: string;
    radius?: number;
  }) {
    this.cancelPrefetch();
    const controller = new AbortController();
    this.prefetchController = controller;

    const { zDimIdx, tDimIdx, currentZ, currentT, maxZ, maxT, numDims, dimSep } = opts;
    const radius = opts.radius ?? Math.max(maxZ, maxT);

    // Parse every cached chunk path once, collect templates matching current pos
    const templates: { prefix: string; coords: number[]; join: string }[] = [];
    for (const path of this.cache.keys()) {
      let prefix: string;
      let coords: number[];

      if (dimSep === '/') {
        const parts = path.split('/');
        if (parts.length < numDims + 1) continue;
        const tail = parts.slice(-numDims);
        if (!tail.every(s => /^\d+$/.test(s))) continue;
        coords = tail.map(Number);
        prefix = parts.slice(0, -numDims).join('/') + '/';
      } else {
        const slash = path.lastIndexOf('/');
        if (slash < 0) continue;
        prefix = path.substring(0, slash + 1);
        const seg = path.substring(slash + 1);
        if (!/^\d+(\.\d+)*$/.test(seg)) continue;
        coords = seg.split('.').map(Number);
      }

      if (coords.length !== numDims) continue;
      if (zDimIdx >= 0 && coords[zDimIdx] !== currentZ) continue;
      if (tDimIdx >= 0 && coords[tDimIdx] !== currentT) continue;
      templates.push({ prefix, coords, join: dimSep === '/' ? '/' : '.' });
    }

    // Generate paths nearest-first (d=1, d=-1, d=2, d=-2, …) and fetch in
    // small batches so we yield to display requests between batches.
    const batches: string[][] = [];
    let batch: string[] = [];
    for (let d = 1; d <= radius; d++) {
      for (const sign of [1, -1]) {
        const offset = d * sign;
        for (const { prefix, coords, join } of templates) {
          if (zDimIdx >= 0) {
            const nz = currentZ + offset;
            if (nz >= 0 && nz < maxZ) {
              const c = [...coords]; c[zDimIdx] = nz;
              const p = prefix + c.join(join);
              if (!this.cache.has(p)) batch.push(p);
            }
          }
          if (tDimIdx >= 0) {
            const nt = currentT + offset;
            if (nt >= 0 && nt < maxT) {
              const c = [...coords]; c[tDimIdx] = nt;
              const p = prefix + c.join(join);
              if (!this.cache.has(p)) batch.push(p);
            }
          }
        }
      }
      // Flush batch at the end of each distance ring
      if (batch.length > 0) { batches.push(batch); batch = []; }
    }

    // Process batches sequentially — each batch awaits before the next starts,
    // keeping only a few requests in flight at once so display requests aren't
    // starved. Aborted via the controller when the user scrubs.
    const signal = controller.signal;
    (async () => {
      for (const paths of batches) {
        if (signal.aborted) return;
        await Promise.all(
          paths.map(p => this.getItem(p, { signal }).catch(() => {}))
        );
      }
    })();
  }

  containsItem(item: string) { return this.inner.containsItem(item); }
  keys() { return this.inner.keys(); }
  setItem(item: string, value: any) { return this.inner.setItem(item, value); }
  deleteItem(item: string) { return this.inner.deleteItem(item); }
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
    </svg>
  );
}

function MenuCloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z" />
    </svg>
  );
}

function ColorLensIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-1 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
    </svg>
  );
}

function SearchInfoIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
    </svg>
  );
}

type PanelTab = 'views' | 'appearance' | 'info';

const TAB_ICONS: { key: PanelTab; Icon: React.FC; tooltip: string }[] = [
  { key: 'views', Icon: MapIcon, tooltip: 'Views/Locations' },
  { key: 'appearance', Icon: ColorLensIcon, tooltip: 'Appearance' },
  { key: 'info', Icon: SearchInfoIcon, tooltip: 'Info' },
];

interface ChannelHistogramData {
  bins: number[];
  min: number;
  max: number;
}

interface ChannelInfo {
  label: string;
  color: [number, number, number];
  visible: boolean;
  histogram?: ChannelHistogramData;
  contrastLimits: [number, number];
}

type BlendMode = 'merged' | 'single';

const COLORMAP_OPTIONS = [
  'viridis', 'plasma', 'inferno', 'magma', 'jet',
  'hot', 'cool', 'spring', 'summer', 'autumn', 'winter',
  'bluered', 'rdbu', 'picnic', 'rainbow', 'rainbow_soft',
  'cubehelix', 'greens', 'greys', 'bone', 'copper',
  'blackbody', 'electric', 'portland', 'earth',
];

function LayersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function StepBackIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z" />
    </svg>
  );
}

function StepForwardIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
    </svg>
  );
}

const FPS_OPTIONS = [1, 2, 5, 10, 24];

const DimensionSliderBar = memo(function DimensionSliderBar({ label, current, max, onChange, playing, onPlayingChange, fps, onFpsChange, showSlider, barWidth }: {
  label: string;
  current: number;
  max: number;
  onChange: (v: number) => void;
  playing?: boolean;
  onPlayingChange?: (p: boolean) => void;
  fps?: number;
  onFpsChange?: (f: number) => void;
  showSlider?: boolean;
  barWidth?: number;
}) {
  const showPlayback = !!(onPlayingChange && onFpsChange);
  const compact = (barWidth ?? 999) < 180;

  const stepBack = () => { onChange(current <= 0 ? max - 1 : current - 1); };
  const stepForward = () => { onChange((current + 1) % max); };

  const btnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: compact ? 2 : 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'rgba(255,255,255,0.7)',
    borderRadius: 4,
    flexShrink: 0,
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: compact ? 1 : 4,
      padding: compact ? '0 3px 0 1px' : '0 8px 0 4px',
      height: BTN_SIZE,
      whiteSpace: 'nowrap',
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
    }}>
      <button onClick={stepBack} style={btnStyle} title="Previous">
        <StepBackIcon />
      </button>

      {showSlider !== false && (
        <input
          type="range"
          min={0}
          max={max - 1}
          value={current}
          onChange={(e) => { if (playing) onPlayingChange?.(false); onChange(Number(e.target.value)); }}
          style={{
            flex: 1,
            minWidth: 30,
            height: 4,
            cursor: 'pointer',
            accentColor: 'rgba(130,180,255,1)',
          }}
        />
      )}

      <button onClick={stepForward} style={btnStyle} title="Next">
        <StepForwardIcon />
      </button>

      {showPlayback && (
        <>
          <button
            onClick={() => onPlayingChange?.(!playing)}
            style={{ ...btnStyle, color: playing ? 'rgba(130,180,255,1)' : 'rgba(255,255,255,0.7)' }}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            onClick={() => {
              const idx = FPS_OPTIONS.indexOf(fps ?? 5);
              onFpsChange?.(FPS_OPTIONS[(idx + 1) % FPS_OPTIONS.length]);
            }}
            style={{
              ...btnStyle,
              fontSize: 9,
              fontWeight: 700,
              minWidth: compact ? 28 : 36,
              color: 'rgba(255,255,255,0.7)',
              background: 'rgba(255,255,255,0.08)',
              borderRadius: 8,
              padding: compact ? '2px 3px' : '2px 6px',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            title="Frames per second (click to cycle)"
          >
            {fps ?? 5} fps
          </button>
        </>
      )}

      <span style={{
        fontSize: 10,
        fontWeight: 600,
        color: 'rgba(255,255,255,0.7)',
        textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 1,
        overflow: 'hidden',
        minWidth: 0,
      }}>
        {label}: {current + 1}/{max}
      </span>
    </div>
  );
});

type ToolbarPanel = 'menu' | 'z' | 't' | null;

interface OverlayMenuProps {
  open: boolean;
  onToggle: () => void;
  containerW: number;
  containerH: number;
  views: SavedView[];
  channels: ChannelInfo[];
  blendMode: BlendMode;
  colormap: string;
  portalTarget: HTMLElement | null;
  onToggleChannel: (index: number) => void;
  onColorChange: (index: number, color: [number, number, number]) => void;
  onContrastChange: (index: number, limits: [number, number]) => void;
  onBlendModeChange: (mode: BlendMode) => void;
  onColormapChange: (colormap: string) => void;
  onApplyAppearance: (appearance: SavedViewAppearance) => void;
  annotationsVisible: boolean;
  onAnnotationsVisibleChange: (visible: boolean) => void;
  scaleBarVisible: boolean;
  onScaleBarVisibleChange: (visible: boolean) => void;
  hasScaleBar: boolean;
  titleVisible: boolean;
  onTitleVisibleChange: (visible: boolean) => void;
  hasTitle: boolean;
  navigateTo: (dest: { zoom: number; target: [number, number, number] }) => void;
  onViewSelect: (view: SavedView) => void;
}

const ELLIPSIS: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function ViewCard({ view, onSelect }: { view: SavedView; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 6,
        cursor: 'pointer',
        color: 'inherit',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { (e.currentTarget.style.background = 'rgba(255,255,255,0.12)'); }}
      onMouseLeave={(e) => { (e.currentTarget.style.background = 'rgba(255,255,255,0.06)'); }}
    >
      <div style={{ ...ELLIPSIS, fontSize: 12, fontWeight: 500 }}>{view.name}</div>
      {view.description && (
        <div style={{ ...ELLIPSIS, fontSize: 10, opacity: 0.5, marginTop: 2 }}>{view.description}</div>
      )}
    </button>
  );
}

function EyeIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
    </svg>
  );
}

function rgbStr(c: [number, number, number]) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
    >
      <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
    </svg>
  );
}

const HIST_BINS = 64;

function computeHistogram(pixelData: ArrayLike<number>, bins: number): { bins: number[]; min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixelData.length; i++) {
    const v = pixelData[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return { bins: Array(bins).fill(1), min, max: max + 1 };
  const counts = new Array(bins).fill(0);
  const range = max - min;
  for (let i = 0; i < pixelData.length; i++) {
    const idx = Math.min(Math.floor(((pixelData[i] - min) / range) * bins), bins - 1);
    counts[idx]++;
  }
  // Log scale for better visual spread
  const maxCount = Math.max(...counts);
  const normalized = counts.map((c: number) => maxCount > 0 ? Math.log1p(c) / Math.log1p(maxCount) : 0);
  return { bins: normalized, min, max };
}

function ChannelHistogramSlider({ histogram, contrastLimits, color, onChange }: {
  histogram: ChannelHistogramData;
  contrastLimits: [number, number];
  color: [number, number, number];
  onChange: (limits: [number, number]) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'lo' | 'hi' | null>(null);

  const range = histogram.max - histogram.min;
  const loFrac = range > 0 ? (contrastLimits[0] - histogram.min) / range : 0;
  const hiFrac = range > 0 ? (contrastLimits[1] - histogram.min) / range : 1;

  const valFromX = useCallback((clientX: number): number => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(histogram.min + frac * range);
  }, [histogram.min, range]);

  const onPointerDown = useCallback((which: 'lo' | 'hi') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = which;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const val = valFromX(e.clientX);
    if (dragging.current === 'lo') {
      onChange([Math.min(val, contrastLimits[1] - 1), contrastLimits[1]]);
    } else {
      onChange([contrastLimits[0], Math.max(val, contrastLimits[0] + 1)]);
    }
  }, [valFromX, contrastLimits, onChange]);

  const onPointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  const barColor = `rgba(${color[0]},${color[1]},${color[2]},0.6)`;
  const dimColor = `rgba(${color[0]},${color[1]},${color[2]},0.15)`;
  const handleColor = `rgb(${color[0]},${color[1]},${color[2]})`;

  return (
    <div
      ref={trackRef}
      style={{ position: 'relative', width: '100%', height: 48, userSelect: 'none', touchAction: 'none' }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg width="100%" height="38" viewBox={`0 0 ${histogram.bins.length} 1`} preserveAspectRatio="none"
        style={{ display: 'block', borderRadius: '6px 6px 0 0', overflow: 'hidden' }}>
        {histogram.bins.map((h, i) => {
          const frac = i / histogram.bins.length;
          const inRange = frac >= loFrac && frac <= hiFrac;
          return (
            <rect
              key={i}
              x={i}
              y={1 - h}
              width={1.05}
              height={h}
              fill={inRange ? barColor : dimColor}
            />
          );
        })}
      </svg>

      <div style={{
        position: 'relative', height: 10,
        background: 'rgba(255,255,255,0.04)',
        borderRadius: '0 0 6px 6px',
      }}>
        <div style={{
          position: 'absolute',
          left: `${loFrac * 100}%`,
          width: `${(hiFrac - loFrac) * 100}%`,
          top: 3, height: 4,
          background: `rgba(${color[0]},${color[1]},${color[2]},0.4)`,
          borderRadius: 2,
        }} />

        <div
          onPointerDown={onPointerDown('lo')}
          style={{
            position: 'absolute',
            left: `${loFrac * 100}%`,
            top: 0, transform: 'translateX(-50%)',
            width: 10, height: 10,
            borderRadius: 3,
            background: handleColor,
            border: '1.5px solid rgba(255,255,255,0.6)',
            cursor: 'ew-resize',
            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          }}
        />

        <div
          onPointerDown={onPointerDown('hi')}
          style={{
            position: 'absolute',
            left: `${hiFrac * 100}%`,
            top: 0, transform: 'translateX(-50%)',
            width: 10, height: 10,
            borderRadius: 3,
            background: handleColor,
            border: '1.5px solid rgba(255,255,255,0.6)',
            cursor: 'ew-resize',
            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
          }}
        />
      </div>
    </div>
  );
}

const COLOR_SWATCHES: [number, number, number][] = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [0, 255, 255], [255, 0, 255],
  [255, 128, 0], [0, 200, 100], [128, 0, 255],
  [255, 80, 80], [80, 255, 80], [80, 180, 255],
  [255, 200, 60], [60, 220, 200], [200, 100, 255],
  [255, 255, 255], [200, 200, 200], [128, 128, 128],
];

const SWATCH_SIZE = 22;
const SWATCH_GAP = 5;
const PICKER_PAD = 8;
const PICKER_MARGIN = 6;

function pickerGridCols(containerW: number): number {
  const availW = containerW - PICKER_MARGIN * 2 - PICKER_PAD * 2;
  const cols = Math.floor((availW + SWATCH_GAP) / (SWATCH_SIZE + SWATCH_GAP));
  return Math.max(3, Math.min(6, cols));
}

function ColorPickerPopover({ color, onSelect, onClose, anchorRef, portalTarget }: {
  color: [number, number, number];
  onSelect: (c: [number, number, number]) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  portalTarget: HTMLElement | null;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [cols, setCols] = useState(6);

  useEffect(() => {
    if (!anchorRef.current || !portalTarget) return;

    const containerRect = portalTarget.getBoundingClientRect();
    const numCols = pickerGridCols(containerRect.width);
    setCols(numCols);

    requestAnimationFrame(() => {
      if (!anchorRef.current || !popoverRef.current) return;
      const anchorRect = anchorRef.current.getBoundingClientRect();
      const popRect = popoverRef.current.getBoundingClientRect();
      const cRect = portalTarget.getBoundingClientRect();

      let top = anchorRect.top - cRect.top - PICKER_MARGIN;
      let left = anchorRect.right - cRect.left - popRect.width;

      top = Math.max(PICKER_MARGIN, Math.min(top, cRect.height - popRect.height - PICKER_MARGIN));
      left = Math.max(PICKER_MARGIN, Math.min(left, cRect.width - popRect.width - PICKER_MARGIN));

      if (anchorRect.top - cRect.top < popRect.height + PICKER_MARGIN * 2) {
        top = anchorRect.bottom - cRect.top + PICKER_MARGIN;
        top = Math.min(top, cRect.height - popRect.height - PICKER_MARGIN);
      }

      setPos({ top, left });
    });
  }, [anchorRef, portalTarget]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, anchorRef]);

  if (!portalTarget) return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: 'absolute',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
        ...GLASS,
        background: 'rgba(20,20,20,0.85)',
        borderRadius: 10,
        padding: PICKER_PAD,
        zIndex: 100,
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: SWATCH_GAP,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        maxWidth: `calc(100% - ${PICKER_MARGIN * 2}px)`,
        maxHeight: `calc(100% - ${PICKER_MARGIN * 2}px)`,
        overflowY: 'auto',
      }}
    >
      {COLOR_SWATCHES.map((c, i) => {
        const selected = c[0] === color[0] && c[1] === color[1] && c[2] === color[2];
        return (
          <button
            key={i}
            onClick={() => onSelect(c)}
            style={{
              width: SWATCH_SIZE, height: SWATCH_SIZE, borderRadius: 5,
              border: selected ? '2px solid #fff' : '1px solid rgba(255,255,255,0.12)',
              background: rgbStr(c),
              cursor: 'pointer',
              padding: 0,
              boxShadow: selected ? '0 0 6px rgba(255,255,255,0.3)' : 'none',
              transform: selected ? 'scale(1.15)' : 'scale(1)',
              transition: 'transform 0.12s, box-shadow 0.12s',
            }}
          />
        );
      })}
    </div>,
    portalTarget,
  );
}

function ChannelCard({ channel, onToggle, onColorChange, onContrastChange, portalTarget }: {
  channel: ChannelInfo;
  onToggle: () => void;
  onColorChange: (color: [number, number, number]) => void;
  onContrastChange: (limits: [number, number]) => void;
  portalTarget: HTMLElement | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const swatchRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        marginBottom: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', height: 22 }}>
        <button
          onClick={onToggle}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 2,
            display: 'flex', alignItems: 'center',
            color: channel.visible ? rgbStr(channel.color) : 'rgba(255,255,255,0.2)',
            flexShrink: 0, transition: 'color 0.15s',
          }}
        >
          <EyeIcon visible={channel.visible} />
        </button>
        <div
          style={{
            ...ELLIPSIS, flex: 1, fontSize: 11,
            color: channel.visible ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
            transition: 'color 0.15s',
          }}
        >
          {channel.label}
        </div>
        <button
          onClick={() => { setExpanded((v) => !v); if (expanded) setColorPickerOpen(false); }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 2,
            display: 'flex', alignItems: 'center',
            color: 'rgba(255,255,255,0.4)', flexShrink: 0,
          }}
        >
          <ChevronIcon open={expanded} />
        </button>
      </div>

      <div style={{ display: expanded ? 'flex' : 'none', alignItems: 'center', gap: 6, padding: '4px 8px 8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {channel.histogram ? (
            <ChannelHistogramSlider
              histogram={channel.histogram}
              contrastLimits={channel.contrastLimits}
              color={channel.color}
              onChange={onContrastChange}
            />
          ) : (
            <div style={{
              height: 48, borderRadius: 6,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.06)',
            }} />
          )}
        </div>
        <button
          ref={swatchRef}
          onClick={() => setColorPickerOpen((v) => !v)}
          style={{
            width: 22, height: 22, flexShrink: 0,
            borderRadius: '50%',
            border: '2px solid rgba(255,255,255,0.2)',
            background: rgbStr(channel.color),
            cursor: 'pointer',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            padding: 0,
            boxShadow: `0 0 6px ${rgbStr(channel.color)}40`,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.5)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; }}
        />
        {colorPickerOpen && (
          <ColorPickerPopover
            color={channel.color}
            anchorRef={swatchRef}
            portalTarget={portalTarget}
            onSelect={(c) => { onColorChange(c); setColorPickerOpen(false); }}
            onClose={() => setColorPickerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function AdditiveToggle({ active, onChange }: { active: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!active)}
      style={{
        flexShrink: 0,
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 6,
        background: active ? 'rgba(130,180,255,0.25)' : 'transparent',
        color: active ? 'rgba(130,180,255,1)' : 'rgba(255,255,255,0.35)',
        fontSize: 9,
        fontWeight: 600,
        padding: '4px 6px',
        cursor: 'pointer',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      Add.
    </button>
  );
}

function AppearancePanel({ channels, blendMode, colormap, onToggleChannel, onColorChange, onContrastChange, onBlendModeChange, onColormapChange, portalTarget }: {
  channels: ChannelInfo[];
  blendMode: BlendMode;
  colormap: string;
  onToggleChannel: (i: number) => void;
  onColorChange: (i: number, color: [number, number, number]) => void;
  onContrastChange: (i: number, limits: [number, number]) => void;
  onBlendModeChange: (m: BlendMode) => void;
  onColormapChange: (c: string) => void;
  portalTarget: HTMLElement | null;
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <AdditiveToggle active={blendMode === 'merged'} onChange={(v) => onBlendModeChange(v ? 'merged' : 'single')} />
        <select
          disabled={blendMode !== 'merged'}
          value={colormap}
          onChange={(e) => onColormapChange(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            color: blendMode === 'merged' ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.25)',
            fontSize: 10,
            padding: '4px 6px',
            cursor: blendMode === 'merged' ? 'pointer' : 'default',
            outline: 'none',
          }}
        >
          {COLORMAP_OPTIONS.map((name) => (
            <option key={name} value={name}>
              {name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {channels.map((ch, i) => (
          <ChannelCard key={i} channel={ch} onToggle={() => onToggleChannel(i)} onColorChange={(c) => onColorChange(i, c)} onContrastChange={(l) => onContrastChange(i, l)} portalTarget={portalTarget} />
        ))}
      </div>
    </>
  );
}

const ANNOTATION_HIT_RADIUS = 16;
const ANNOTATION_PIN_H = 18;
const ANNOTATION_PIN_W = 12;
const ANNOTATION_LABEL_MAX_W = 120;
const DEFAULT_ANNOTATION_COLOR: [number, number, number] = [255, 100, 100];

/** Draw a map-pin shape onto a 2D canvas context at (cx, cy) pointing down.
 *  The pin tip is at (cx, cy); the body extends upward. */
function drawPin(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string, scale: number) {
  const w = ANNOTATION_PIN_W * scale;
  const h = ANNOTATION_PIN_H * scale;
  const r = w / 2;

  ctx.save();
  ctx.translate(cx, cy);

  // Shadow
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 3 * scale;
  ctx.shadowOffsetY = 1 * scale;

  // Pin body: a circle-topped teardrop shape
  ctx.beginPath();
  ctx.moveTo(0, 0); // tip
  ctx.bezierCurveTo(-w * 0.4, -h * 0.4, -r, -h * 0.55, -r, -h + r);
  ctx.arc(0, -h + r, r, Math.PI, 0, false);
  ctx.bezierCurveTo(r, -h * 0.55, w * 0.4, -h * 0.4, 0, 0);
  ctx.fillStyle = color;
  ctx.fill();

  // Inner dot
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.arc(0, -h + r, r * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();

  ctx.restore();
}

function useAnnotationHover(
  containerRef: React.RefObject<HTMLElement | null>,
  annotations: Annotation[],
  visible: boolean,
  viewState: any,
  containerW: number,
  containerH: number,
  sliceFilterRef?: React.RefObject<{ currentZ: number; currentT: number }>,
) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [pressedIdx, setPressedIdx] = useState<number | null>(null);

  const viewStateRef = useRef(viewState);
  const annotationsRef = useRef(annotations);
  const sizeRef = useRef({ w: containerW, h: containerH });
  viewStateRef.current = viewState;
  annotationsRef.current = annotations;
  sizeRef.current = { w: containerW, h: containerH };

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !visible) {
      setHoveredIdx(null);
      setPressedIdx(null);
      return;
    }

    const hitTest = (e: MouseEvent): number | null => {
      const vs = viewStateRef.current;
      const anns = annotationsRef.current;
      const { w, h } = sizeRef.current;
      if (!vs || anns.length === 0) return null;

      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const scale = Math.pow(2, vs.zoom);

      let closest: number | null = null;
      let closestDist = Infinity;

      const sf = sliceFilterRef?.current;
      for (let i = 0; i < anns.length; i++) {
        const a = anns[i];
        if (sf && ((a.z !== undefined && a.z !== sf.currentZ) || (a.t !== undefined && a.t !== sf.currentT))) continue;
        const sx = (a.target[0] - vs.target[0]) * scale + w / 2;
        const sy = (a.target[1] - vs.target[1]) * scale + h / 2;
        if (sx < -ANNOTATION_HIT_RADIUS || sx > w + ANNOTATION_HIT_RADIUS ||
            sy < -ANNOTATION_PIN_H - ANNOTATION_HIT_RADIUS || sy > h + ANNOTATION_HIT_RADIUS) continue;
        const dx = mx - sx;
        const dy = my - (sy - ANNOTATION_PIN_H / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < ANNOTATION_HIT_RADIUS && dist < closestDist) {
          closest = i;
          closestDist = dist;
        }
      }
      return closest;
    };

    const onMove = (e: MouseEvent) => setHoveredIdx(hitTest(e));
    const onLeave = () => { setHoveredIdx(null); setPressedIdx(null); };
    const onDown = (e: MouseEvent) => {
      const idx = hitTest(e);
      if (idx !== null) setPressedIdx(idx);
    };
    const onUp = () => setPressedIdx(null);

    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
    };
  }, [containerRef, visible]);

  return { hoveredIdx, pressedIdx };
}

/** Canvas-based annotation overlay — draws all markers in a single pass
 *  instead of creating a DOM node per annotation. Handles hundreds of
 *  annotations at 60fps with viewport culling. */
const AnnotationOverlay = memo(function AnnotationOverlay({ annotations, visible, viewState, containerW, containerH, hoveredIdx, pressedIdx, currentZ, currentT }: {
  annotations: Annotation[];
  visible: boolean;
  viewState: any;
  containerW: number;
  containerH: number;
  hoveredIdx: number | null;
  pressedIdx: number | null;
  currentZ: number;
  currentT: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visible || !viewState || annotations.length === 0) {
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const cw = containerW;
    const ch = containerH;

    // Resize canvas backing store to match CSS size × device pixel ratio
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const scale = Math.pow(2, viewState.zoom);
    const margin = ANNOTATION_PIN_H + 30; // pin height + label headroom

    // Draw non-hovered markers first, then hovered on top
    let hoveredAnnotation: { a: Annotation; sx: number; sy: number } | null = null;

    for (let i = 0; i < annotations.length; i++) {
      const a = annotations[i];
      if ((a.z !== undefined && a.z !== currentZ) || (a.t !== undefined && a.t !== currentT)) continue;

      const sx = (a.target[0] - viewState.target[0]) * scale + cw / 2;
      const sy = (a.target[1] - viewState.target[1]) * scale + ch / 2;

      // Viewport culling
      if (sx < -margin || sx > cw + margin || sy < -margin || sy > ch + margin) continue;

      if (i === hoveredIdx) {
        hoveredAnnotation = { a, sx, sy };
        continue; // draw last so it's on top
      }

      const color = a.color ?? DEFAULT_ANNOTATION_COLOR;
      drawPin(ctx, sx, sy, rgbStr(color), 1);
    }

    // Draw hovered marker larger + with label
    if (hoveredAnnotation) {
      const { a, sx, sy } = hoveredAnnotation;
      const color = a.color ?? DEFAULT_ANNOTATION_COLOR;
      drawPin(ctx, sx, sy, rgbStr(color), 1.2);

      // Label tooltip above the pin
      const isPressed = pressedIdx === hoveredIdx && pressedIdx !== null;
      ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      let label = a.name;
      const maxLabelW = isPressed ? cw - 24 : ANNOTATION_LABEL_MAX_W; // full width minus margin when pressed
      const ellipsis = '\u2026';
      if (ctx.measureText(label).width > maxLabelW) {
        while (label.length > 1 && ctx.measureText(label + ellipsis).width > maxLabelW) {
          label = label.slice(0, -1);
        }
        label = label.trimEnd() + ellipsis;
      }
      const textW = ctx.measureText(label).width;
      const padX = 8;
      const padY = 3;
      const boxW = textW + padX * 2;
      const boxH = 16 + padY * 2;
      // Clamp horizontally so the box stays within the container
      let boxX = sx - boxW / 2;
      if (boxX < 4) boxX = 4;
      if (boxX + boxW > cw - 4) boxX = cw - 4 - boxW;
      const boxY = sy - ANNOTATION_PIN_H * 1.2 - boxH - 2;
      const textCenterX = boxX + boxW / 2;

      // Background pill
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      const r = 6;
      ctx.roundRect(boxX, boxY, boxW, boxH, r);
      ctx.fillStyle = 'rgba(20,20,20,0.85)';
      ctx.fill();
      ctx.restore();

      // Label text
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, textCenterX, boxY + boxH / 2);
    }
  }, [annotations, visible, viewState, containerW, containerH, hoveredIdx, pressedIdx, currentZ, currentT]);

  if (!visible || !viewState || annotations.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: containerW,
        height: containerH,
        pointerEvents: 'none',
      }}
    />
  );
});

interface PhysicalScale {
  pixelSize: number;
  unit: string;
}

const UNIT_LABELS: Record<string, string> = {
  micrometer: '\u00b5m',
  micrometre: '\u00b5m',
  nanometer: 'nm',
  nanometre: 'nm',
  millimeter: 'mm',
  millimetre: 'mm',
  centimeter: 'cm',
  centimetre: 'cm',
  meter: 'm',
  metre: 'm',
  angstrom: '\u00c5',
};

function extractPhysicalScale(metadata: any): PhysicalScale | null {
  try {
    const ms = metadata?.multiscales?.[0];
    if (!ms) return null;

    const axes: any[] = ms.axes ?? [];
    const xIdx = axes.findIndex((a: any) =>
      (a.type === 'space' && a.name === 'x') ||
      (typeof a === 'string' && a === 'x')
    );
    if (xIdx < 0) return null;

    const unit = typeof axes[xIdx] === 'object' ? axes[xIdx].unit : undefined;
    if (!unit) return null;

    const dataset0 = ms.datasets?.[0];
    const perLevel = dataset0?.coordinateTransformations?.find((t: any) => t.type === 'scale');
    const groupLevel = ms.coordinateTransformations?.find((t: any) => t.type === 'scale');

    let pixelSize = perLevel?.scale?.[xIdx] ?? 1;
    if (groupLevel?.scale?.[xIdx]) {
      pixelSize *= groupLevel.scale[xIdx];
    }

    return { pixelSize, unit };
  } catch {
    return null;
  }
}

const NICE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

function niceScaleValue(maxPhysical: number): number {
  let best = NICE_STEPS[0];
  for (const step of NICE_STEPS) {
    if (step <= maxPhysical) best = step;
    else break;
  }
  return best;
}

const SCALE_BAR_DEFAULTS = {
  maxWidth: 100,
  position: 'bottom-right' as const,
};

const SCALE_BAR_FONT_STACKS: Record<ScaleBarFont, string> = {
  'Arial': "Arial, Helvetica, sans-serif",
  'Helvetica': "Helvetica, Arial, sans-serif",
  'Georgia': "Georgia, 'Times New Roman', serif",
  'Times New Roman': "'Times New Roman', Times, serif",
  'Courier New': "'Courier New', Courier, monospace",
};

const ScaleBarOverlay = memo(function ScaleBarOverlay({ physicalScale, viewState, config, visible }: {
  physicalScale: PhysicalScale;
  viewState: any;
  config: Required<Pick<ScaleBarConfig, 'maxWidth' | 'position'>> & Pick<ScaleBarConfig, 'fontSize' | 'font' | 'color'>;
  visible: boolean;
}) {
  if (!visible || !viewState) return null;

  const zoom = viewState.zoom;
  const screenScale = Math.pow(2, zoom); // pixels per image-pixel at current zoom
  const physPerScreenPx = physicalScale.pixelSize / screenScale;

  // How many physical units fit in maxWidth screen pixels?
  const maxPhysical = physPerScreenPx * config.maxWidth;
  const niceVal = niceScaleValue(maxPhysical);
  const barWidthPx = niceVal / physPerScreenPx;

  const unitLabel = UNIT_LABELS[physicalScale.unit] ?? physicalScale.unit;
  const label = `${niceVal} ${unitLabel}`;

  const pos = config.position;
  const margin = 12;
  const posStyle: React.CSSProperties = {
    position: 'absolute',
    ...(pos.includes('bottom') ? { bottom: margin } : { top: margin }),
    ...(pos.includes('right') ? { right: margin } : { left: margin }),
  };

  return (
    <div style={{
      ...posStyle,
      pointerEvents: 'none',
      display: 'flex',
      flexDirection: 'column',
      alignItems: pos.includes('right') ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        fontSize: config.fontSize ?? 10,
        fontFamily: SCALE_BAR_FONT_STACKS[config.font ?? 'Arial'],
        fontWeight: 600,
        color: config.color ?? 'rgba(255,255,255,0.9)',
        textShadow: '0 1px 3px rgba(0,0,0,0.8)',
        marginBottom: 3,
        letterSpacing: '0.02em',
      }}>
        {label}
      </div>
      <div style={{
        width: barWidthPx,
        height: 3,
        background: config.color ?? 'rgba(255,255,255,0.9)',
        borderRadius: 1.5,
        boxShadow: '0 1px 4px rgba(0,0,0,0.6)',
      }} />
    </div>
  );
});

const OverlayMenu = memo(function OverlayMenu({ open, onToggle, containerW, containerH, views, channels, blendMode, colormap, portalTarget, onToggleChannel, onColorChange, onContrastChange, onBlendModeChange, onColormapChange, onApplyAppearance, annotationsVisible, onAnnotationsVisibleChange, scaleBarVisible, onScaleBarVisibleChange, hasScaleBar, titleVisible, onTitleVisibleChange, hasTitle, navigateTo, onViewSelect }: OverlayMenuProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('views');

  const panelW = clamp(containerW - PANEL_MARGIN, PANEL_MIN_W, PANEL_MAX_W);
  const panelH = clamp(containerH - PANEL_MARGIN, PANEL_MIN_H, PANEL_MAX_H);

  return (
    <div
      style={{
        ...GLASS,
        width: open ? panelW : BTN_SIZE,
        height: open ? panelH : BTN_SIZE,
        borderRadius: open ? 12 : BTN_SIZE / 2,
        overflow: 'hidden',
        color: 'rgba(255,255,255,0.85)',
        transition: TRANSITION,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: BTN_SIZE,
        }}
      >
        <button
          onClick={onToggle}
          style={{
            width: BTN_SIZE,
            height: BTN_SIZE,
            marginLeft: 0,
            flexShrink: 0,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            color: 'inherit',
          }}
        >
          {open ? <MenuCloseIcon /> : <MenuIcon />}
        </button>

        {open && (
          <div
            style={{
              display: 'flex',
              flex: 1,
              justifyContent: 'space-evenly',
              alignItems: 'center',
              opacity: open ? 1 : 0,
              transition: 'opacity 0.15s ease 0.15s',
            }}
          >
            {TAB_ICONS.map(({ key, Icon, tooltip }) => {
              const active = activeTab === key;
              return (
                <button
                  key={key}
                  title={tooltip}
                  onClick={() => setActiveTab(key)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 4,
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: active
                      ? 'rgba(130,180,255,1)'
                      : 'rgba(255,255,255,0.5)',
                    transition: 'color 0.2s',
                  }}
                >
                  <Icon />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div
        style={{
          position: 'absolute',
          top: BTN_SIZE + 2,
          left: 0,
          right: 0,
          bottom: 0,
          padding: '0 10px 10px',
          opacity: open ? 1 : 0,
          transition: open
            ? 'opacity 0.2s ease 0.15s'
            : 'opacity 0.1s ease',
          pointerEvents: open ? 'auto' : 'none',
          fontSize: 13,
          overflowY: 'auto',
        }}
      >
        {activeTab === 'views' && views.map((v, i) => (
          <ViewCard key={i} view={v} onSelect={() => onViewSelect(v)} />
        ))}
        {activeTab === 'appearance' && (
          <AppearancePanel
            channels={channels}
            blendMode={blendMode}
            colormap={colormap}
            onToggleChannel={onToggleChannel}
            onColorChange={onColorChange}
            onContrastChange={onContrastChange}
            onBlendModeChange={onBlendModeChange}
            onColormapChange={onColormapChange}
            portalTarget={portalTarget}
          />
        )}
        {activeTab === 'info' && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <button
              onClick={() => onAnnotationsVisibleChange(!annotationsVisible)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                padding: '6px 10px',
                cursor: 'pointer',
                color: 'inherit',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
            >
              <span style={{
                display: 'flex', alignItems: 'center',
                color: annotationsVisible ? 'rgba(255,100,100,0.9)' : 'rgba(255,255,255,0.2)',
                transition: 'color 0.15s',
              }}>
                <EyeIcon visible={annotationsVisible} />
              </span>
              <span style={{
                fontSize: 11, fontWeight: 500,
                color: annotationsVisible ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
                transition: 'color 0.15s',
              }}>
                Annotations
              </span>
            </button>
            {hasScaleBar && (
              <button
                onClick={() => onScaleBarVisibleChange(!scaleBarVisible)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  marginTop: 6,
                  cursor: 'pointer',
                  color: 'inherit',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              >
                <span style={{
                  display: 'flex', alignItems: 'center',
                  color: scaleBarVisible ? 'rgba(130,180,255,0.9)' : 'rgba(255,255,255,0.2)',
                  transition: 'color 0.15s',
                }}>
                  <EyeIcon visible={scaleBarVisible} />
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 500,
                  color: scaleBarVisible ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
                  transition: 'color 0.15s',
                }}>
                  Scale Bar
                </span>
              </button>
            )}
            {hasTitle && (
              <button
                onClick={() => onTitleVisibleChange(!titleVisible)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  marginTop: 6,
                  cursor: 'pointer',
                  color: 'inherit',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              >
                <span style={{
                  display: 'flex', alignItems: 'center',
                  color: titleVisible ? 'rgba(255,220,100,0.9)' : 'rgba(255,255,255,0.2)',
                  transition: 'color 0.15s',
                }}>
                  <EyeIcon visible={titleVisible} />
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 500,
                  color: titleVisible ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
                  transition: 'color 0.15s',
                }}>
                  Title
                </span>
              </button>
            )}
            <div style={{
              marginTop: 'auto',
              paddingTop: 10,
              borderTop: '1px solid rgba(255,255,255,0.08)',
              fontSize: 9,
              color: 'rgba(255,255,255,0.3)',
              lineHeight: 1.5,
              textAlign: 'center',
            }}>
              <div>microATLAS v{VERSION}</div>
              <div>Andrew James Brodrick, 2026</div>
              <a
                href="https://github.com/LadInTheLab"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'rgba(130,180,255,0.5)', textDecoration: 'none' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(130,180,255,0.8)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(130,180,255,0.5)'; }}
              >
                github.com/LadInTheLab
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

interface ViewerToolbarProps {
  numZ: number;
  numT: number;
  currentZ: number;
  currentT: number;
  onZChange: (z: number) => void;
  onTChange: (t: number) => void;
  tPlaying: boolean;
  tFps: number;
  onTPlayingChange: (p: boolean) => void;
  onTFpsChange: (f: number) => void;
  containerW: number;
  menuProps: Omit<OverlayMenuProps, 'open' | 'onToggle'>;
}

// Ideal slider bar widths; actual width is clamped to available space
const SLIDER_BAR_W_IDEAL = 280;
const SLIDER_BAR_W_PLAYBACK_IDEAL = 360;
// Slider hidden below this bar width
const SLIDER_VISIBLE_THRESHOLD = 180;
const SLIDER_VISIBLE_THRESHOLD_PLAYBACK = 260;
const GAP = 6;

const ViewerToolbar = memo(function ViewerToolbar({ numZ, numT, currentZ, currentT, onZChange, onTChange, tPlaying, tFps, onTPlayingChange, onTFpsChange, containerW, menuProps }: ViewerToolbarProps) {
  ensureSpinKeyframes();
  const [openPanel, setOpenPanel] = useState<ToolbarPanel>(null);

  const toggle = useCallback((panel: 'menu' | 'z' | 't') => {
    setOpenPanel((prev) => prev === panel ? null : panel);
  }, []);

  const hasZ = numZ > 1;
  const hasT = numT > 1;

  // Compute available width for an expanded bar.
  // Layout: [INSET] [Menu BTN] [gap] [...collapsed before] [THIS bar] [...collapsed after] [INSET]
  const barAvailW = (panel: 'z' | 't') => {
    // Menu button is always before
    let used = INSET * 2 + BTN_SIZE + GAP;
    if (panel === 'z') {
      // Z is right after menu; T may be collapsed after
      if (hasT) used += GAP + BTN_SIZE;
    } else {
      // T: Z is collapsed before (between menu and T)
      if (hasZ) used += GAP + BTN_SIZE;
    }
    return containerW - used;
  };

  const zBarW = openPanel === 'z'
    ? Math.min(barAvailW('z'), SLIDER_BAR_W_IDEAL)
    : BTN_SIZE;
  const tBarW = openPanel === 't'
    ? Math.min(barAvailW('t'), SLIDER_BAR_W_PLAYBACK_IDEAL)
    : BTN_SIZE;

  const showZSlider = zBarW >= SLIDER_VISIBLE_THRESHOLD;
  const showTSlider = tBarW >= SLIDER_VISIBLE_THRESHOLD_PLAYBACK;

  return (
    <div style={{
      position: 'absolute',
      top: INSET,
      left: INSET,
      zIndex: 10,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 6,
    }}>
      {/* Menu — circle that expands into the full panel */}
      <OverlayMenu
        open={openPanel === 'menu'}
        onToggle={() => toggle('menu')}
        {...menuProps}
      />

      {/* Z — circle that expands into a horizontal slider bar */}
      {hasZ && (
        <div
          style={{
            ...GLASS,
            width: zBarW,
            height: BTN_SIZE,
            borderRadius: BTN_SIZE / 2,
            overflow: 'hidden',
            color: 'rgba(255,255,255,0.85)',
            display: 'flex',
            alignItems: 'center',
            transition: TRANSITION,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => toggle('z')}
            style={{
              width: BTN_SIZE,
              height: BTN_SIZE,
              marginLeft: -1,
              flexShrink: 0,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              color: 'inherit',
            }}
            title={`Z slice: ${currentZ + 1}/${numZ}`}
          >
            <LayersIcon />
          </button>
          {openPanel === 'z' && (
            <DimensionSliderBar
              label="Z"
              current={currentZ}
              max={numZ}
              onChange={onZChange}
              showSlider={showZSlider}
              barWidth={zBarW}
            />
          )}
        </div>
      )}

      {/* T — circle that expands into a horizontal slider bar with playback */}
      {hasT && (() => {
        const collapsed = openPanel !== 't';
        const showRing = tPlaying && collapsed;
        const RING_PAD = 3;
        const ringSize = BTN_SIZE + RING_PAD * 2;
        return (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            {/* Spinning glow ring behind the circle during playback */}
            {showRing && (
              <div style={{
                position: 'absolute',
                top: -RING_PAD,
                left: -RING_PAD,
                width: ringSize,
                height: ringSize,
                borderRadius: '50%',
                background: 'conic-gradient(from 0deg, rgba(100,160,255,0.7), rgba(100,160,255,0) 120deg, rgba(100,160,255,0) 240deg, rgba(100,160,255,0.7))',
                animation: `${SPIN_KEYFRAMES_ID} 1.8s linear infinite`,
                filter: 'blur(2px)',
                pointerEvents: 'none',
              }} />
            )}
            <div
              style={{
                ...GLASS,
                position: 'relative',
                width: tBarW,
                height: BTN_SIZE,
                borderRadius: BTN_SIZE / 2,
                overflow: 'hidden',
                color: 'rgba(255,255,255,0.85)',
                display: 'flex',
                alignItems: 'center',
                transition: TRANSITION,
              }}
            >
              <button
                onClick={() => toggle('t')}
                style={{
                  width: BTN_SIZE,
                  height: BTN_SIZE,
                  marginLeft: -1,
                  flexShrink: 0,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  color: 'inherit',
                }}
                title={`Time: ${currentT + 1}/${numT}`}
              >
                <ClockIcon />
              </button>
              {openPanel === 't' && (
                <DimensionSliderBar
                  label="T"
                  current={currentT}
                  max={numT}
                  onChange={onTChange}
                  playing={tPlaying}
                  onPlayingChange={onTPlayingChange}
                  fps={tFps}
                  onFpsChange={onTFpsChange}
                  showSlider={showTSlider}
                  barWidth={tBarW}
                />
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
});

export interface SavedViewAppearance {
  channelsVisible?: boolean[];
  channelColors?: [number, number, number][];
  contrastLimits?: [number, number][];
  blendMode?: BlendMode;
  colormap?: string;
}

export interface SavedView {
  name: string;
  description?: string;
  zoom: number;
  target: [number, number, number];
  appearance?: SavedViewAppearance;
  default?: boolean;
  z?: number;
  t?: number;
  playback?: {
    playing?: boolean;
    fps?: number;
    startFrame?: number;
  };
}

export interface Annotation {
  name: string;
  target: [number, number];
  color?: [number, number, number];
  z?: number;
  t?: number;
}

export type ScaleBarFont = 'Arial' | 'Helvetica' | 'Georgia' | 'Times New Roman' | 'Courier New';

export interface ScaleBarConfig {
  maxWidth?: number;
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  fontSize?: number; // px, default 10
  font?: ScaleBarFont;
  color?: string;    // CSS color for text and bar, default 'rgba(255,255,255,0.9)'
}

export type TitlePosition = 'top-center' | 'top-left' | 'top-right' | 'bottom-center' | 'bottom-left' | 'bottom-right';

export type TitleFont =
  | 'Arial' | 'Helvetica' | 'Verdana' | 'Trebuchet MS' | 'Tahoma'
  | 'Georgia' | 'Times New Roman' | 'Palatino'
  | 'Courier New' | 'Lucida Console'
  | 'Impact' | 'Arial Narrow' | 'Futura' | 'Century Gothic'
  | 'Comic Sans MS';

export interface TitleConfig {
  text: string;
  position?: TitlePosition;
  margin?: number;    // px offset from edge, default 12
  fontSize?: number;  // px, default 24
  font?: TitleFont;
  color?: string;     // CSS color, default 'rgba(255,255,255,0.95)'
  style?: 'text' | 'pill'; // 'text' = bare text with shadow, 'pill' = glassmorphism container
}

const TITLE_FONT_STACKS: Record<TitleFont, string> = {
  'Arial': "Arial, Helvetica, sans-serif",
  'Helvetica': "Helvetica, Arial, sans-serif",
  'Verdana': "Verdana, Geneva, sans-serif",
  'Trebuchet MS': "'Trebuchet MS', Helvetica, sans-serif",
  'Tahoma': "Tahoma, Verdana, sans-serif",
  'Georgia': "Georgia, 'Times New Roman', serif",
  'Times New Roman': "'Times New Roman', Times, serif",
  'Palatino': "'Palatino Linotype', 'Book Antiqua', Palatino, serif",
  'Courier New': "'Courier New', Courier, monospace",
  'Lucida Console': "'Lucida Console', Monaco, monospace",
  'Impact': "Impact, 'Arial Black', sans-serif",
  'Arial Narrow': "'Arial Narrow', Arial, sans-serif",
  'Futura': "Futura, 'Century Gothic', sans-serif",
  'Century Gothic': "'Century Gothic', Futura, sans-serif",
  'Comic Sans MS': "'Comic Sans MS', cursive, sans-serif",
};

const TitleOverlay = memo(function TitleOverlay({ config, visible }: {
  config: TitleConfig;
  visible: boolean;
}) {
  if (!visible) return null;

  const pos = config.position ?? 'top-center';
  const fontSize = config.fontSize ?? 24;
  const fontFamily = TITLE_FONT_STACKS[config.font ?? 'Arial'];
  const color = config.color ?? 'rgba(255,255,255,0.95)';
  const margin = config.margin ?? 12;

  const posStyle: React.CSSProperties = {
    position: 'absolute',
    ...(pos.includes('bottom') ? { bottom: margin } : { top: margin }),
    ...(pos.includes('left') ? { left: margin } : {}),
    ...(pos.includes('right') ? { right: margin } : {}),
    ...(pos.includes('center') ? { left: '50%', transform: 'translateX(-50%)' } : {}),
  };

  const isPill = config.style === 'pill';
  const textAlign = pos.includes('center') ? 'center' as const : pos.includes('right') ? 'right' as const : 'left' as const;

  return (
    <div style={{
      ...posStyle,
      pointerEvents: 'none',
      textAlign,
    }}>
      {isPill ? (
        <div style={{
          display: 'inline-block',
          ...GLASS,
          borderRadius: Math.round(fontSize * 0.6),
          padding: `${Math.round(fontSize * 0.3)}px ${Math.round(fontSize * 0.6)}px`,
        }}>
          <span style={{
            fontSize,
            fontFamily,
            fontWeight: 700,
            color,
            lineHeight: 1.2,
            wordBreak: 'break-word',
          }}>
            {config.text}
          </span>
        </div>
      ) : (
        <span style={{
          fontSize,
          fontFamily,
          fontWeight: 700,
          color,
          textShadow: '0 1px 4px rgba(0,0,0,0.8), 0 0 12px rgba(0,0,0,0.5)',
          lineHeight: 1.2,
          wordBreak: 'break-word',
        }}>
          {config.text}
        </span>
      )}
    </div>
  );
});

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

const FLY_DURATION_MS = 800;

function useAnimatedNavigation(
  viewState: any,
  setViewState: (vs: any) => void,
  onViewStateChange?: (vs: any) => void,
) {
  const animRef = useRef<number | null>(null);
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const onChangeRef = useRef(onViewStateChange);
  onChangeRef.current = onViewStateChange;

  const cancel = useCallback(() => {
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  }, []);

  const navigateTo = useCallback(
    (dest: { zoom: number; target: [number, number, number] }) => {
      cancel();
      const from = viewStateRef.current;
      if (!from) {
        setViewState(dest);
        onChangeRef.current?.(dest);
        return;
      }

      const start = performance.now();
      const tick = (now: number) => {
        const elapsed = now - start;
        const raw = Math.min(elapsed / FLY_DURATION_MS, 1);
        const t = easeInOutCubic(raw);

        const next = {
          ...from,
          zoom: lerp(from.zoom, dest.zoom, t),
          target: [
            lerp(from.target[0], dest.target[0], t),
            lerp(from.target[1], dest.target[1], t),
            lerp(from.target[2] ?? 0, dest.target[2] ?? 0, t),
          ] as [number, number, number],
        };

        setViewState(next);
        onChangeRef.current?.(next);

        if (raw < 1) {
          animRef.current = requestAnimationFrame(tick);
        } else {
          animRef.current = null;
        }
      };

      animRef.current = requestAnimationFrame(tick);
    },
    [cancel, setViewState],
  );

  useEffect(() => cancel, [cancel]);

  return { navigateTo, cancelAnimation: cancel };
}

function useContainerSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(() => {
    const el = ref.current;
    if (el) return { w: el.clientWidth, h: el.clientHeight };
    return { w: PANEL_MAX_W + PANEL_MARGIN, h: PANEL_MAX_H + PANEL_MARGIN };
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export interface ViewerProps {
  source: string;
  views?: SavedView[];
  annotations?: Annotation[];
  scaleBar?: ScaleBarConfig | boolean;
  title?: TitleConfig | string;
  defaultAnnotationsVisible?: boolean;
  defaultScaleBarVisible?: boolean;
  defaultTitleVisible?: boolean;
  onViewStateChange?: (viewState: { zoom: number; target: [number, number, number] }) => void;
  onAppearanceChange?: (appearance: SavedViewAppearance) => void;
  onSliceChange?: (slice: { z: number; t: number; playing: boolean; fps: number; numZ: number; numT: number }) => void;
}

export function MicroAtlasViewer({ source, views: externalViews, annotations: externalAnnotations, scaleBar: scaleBarProp, title: titleProp, defaultAnnotationsVisible, defaultScaleBarVisible, defaultTitleVisible, onViewStateChange, onAppearanceChange, onSliceChange }: ViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<any>(null);
  // Reuse extension/view instances so deck.gl doesn't diff new refs every render
  const extensionsRef = useRef<{ additive: any[]; palette: any[] } | null>(null);
  const viewsRef = useRef<any[] | null>(null);
  const containerSize = useContainerSize(containerRef);
  const [viewState, setViewState] = useState<any>(null);
  const [fitView, setFitView] = useState<SavedView | null>(null);
  const initialViewAppliedRef = useRef(false);
  const { navigateTo, cancelAnimation } = useAnimatedNavigation(viewState, setViewState, onViewStateChange);
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;
  const cancelAnimationRef = useRef(cancelAnimation);
  cancelAnimationRef.current = cancelAnimation;
  const handleDeckViewStateChange = useCallback((e: any) => {
    // Ignore DeckGL's initial uncontrolled viewState callback — the initial
    // view effect will set the correct viewState (including any default view).
    if (!initialViewAppliedRef.current) return;
    cancelAnimationRef.current();
    setViewState(e.viewState);
    onViewStateChangeRef.current?.(e.viewState);
  }, []);
  const [channelsVisible, setChannelsVisible] = useState<boolean[]>([]);
  const [channelColors, setChannelColors] = useState<[number, number, number][] | null>(null);
  const [contrastLimitsState, setContrastLimitsState] = useState<[number, number][] | null>(null);
  const [histograms, setHistograms] = useState<ChannelHistogramData[]>([]);
  const [blendMode, setBlendMode] = useState<BlendMode>('single');
  const [colormap, setColormap] = useState('viridis');
  const [annotationsVisible, setAnnotationsVisible] = useState(defaultAnnotationsVisible ?? true);
  const sliceFilterRef = useRef<{ currentZ: number; currentT: number }>({ currentZ: 0, currentT: 0 });
  const { hoveredIdx: annotationHoveredIdx, pressedIdx: annotationPressedIdx } = useAnnotationHover(containerRef, externalAnnotations ?? [], annotationsVisible, viewState, containerSize.w, containerSize.h, sliceFilterRef);
  const [scaleBarVisible, setScaleBarVisible] = useState(defaultScaleBarVisible ?? !!scaleBarProp);
  const titleConfig: TitleConfig | null = typeof titleProp === 'string' ? { text: titleProp } : titleProp ?? null;
  const [titleVisible, setTitleVisible] = useState(defaultTitleVisible ?? true);
  const [physicalScale, setPhysicalScale] = useState<PhysicalScale | null>(null);
  const [currentZ, setCurrentZ] = useState(0);
  const [currentT, setCurrentT] = useState(0);
  const [tPlaying, setTPlaying] = useState(false);
  const [tFps, setTFps] = useState(5);
  // Keep hover hook's slice filter in sync with current Z/T
  sliceFilterRef.current = { currentZ, currentT };
  const onSliceChangeRef = useRef(onSliceChange);
  onSliceChangeRef.current = onSliceChange;
  const cachingStoreRef = useRef<CachingStore | null>(null);
  const scaleBarConfig: Required<Pick<ScaleBarConfig, 'maxWidth' | 'position'>> & Pick<ScaleBarConfig, 'fontSize' | 'font' | 'color'> = {
    maxWidth: (typeof scaleBarProp === 'object' ? scaleBarProp.maxWidth : undefined) ?? SCALE_BAR_DEFAULTS.maxWidth,
    position: (typeof scaleBarProp === 'object' ? scaleBarProp.position : undefined) ?? SCALE_BAR_DEFAULTS.position,
    ...(typeof scaleBarProp === 'object' ? {
      fontSize: scaleBarProp.fontSize,
      font: scaleBarProp.font,
      color: scaleBarProp.color,
    } : {}),
  };
  const [loaded, setLoaded] = useState<{
    viv: VivModule;
    data: any[];
    metadata: VivMetadata;
    numChannels: number;
    numZ: number;
    numT: number;
    dimLabels: string[];
    deckDeps: { DeckGL: any; OrthographicView: any };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const onAppearanceChangeRef = useRef(onAppearanceChange);
  onAppearanceChangeRef.current = onAppearanceChange;
  useEffect(() => {
    if (!onAppearanceChangeRef.current || channelsVisible.length === 0) return;
    onAppearanceChangeRef.current({
      channelsVisible,
      ...(channelColors ? { channelColors } : {}),
      ...(contrastLimitsState ? { contrastLimits: contrastLimitsState } : {}),
      blendMode,
      colormap,
    });
  }, [channelsVisible, channelColors, contrastLimitsState, blendMode, colormap]);

  useEffect(() => {
    if (!loaded || !onSliceChangeRef.current) return;
    onSliceChangeRef.current({ z: currentZ, t: currentT, playing: tPlaying, fps: tFps, numZ: loaded.numZ, numT: loaded.numT });
  }, [currentZ, currentT, tPlaying, tFps, loaded]);

  useEffect(() => {
    if (!source) return;
    setIsLoading(true);
    setError(null);
    setLoaded(null);
    setViewState(null);
    initialViewAppliedRef.current = false;

    Promise.all([
      import('@hms-dbmi/viv'),
      import('@deck.gl/react'),
      import('@deck.gl/core'),
    ])
      .then(([viv, deckReact, deckCore]) =>
        (viv.loadOmeZarr as any)(source, { type: 'multiscales' }).then(
          ({ data, metadata }: { data: any[]; metadata: VivMetadata }) => {
            // Wrap the zarr store with an in-memory LRU cache so revisiting
            // Z/T slices (or panning back) is instant instead of re-fetching.
            const cachingStore = new CachingStore((data[0] as any)._data.store);
            cachingStoreRef.current = cachingStore;
            for (const src of data) {
              (src as any)._data.store = cachingStore;
              (src as any)._data._chunkStore = cachingStore;
            }
            const labels: string[] = data[0]?.labels ?? [];
            const cIdx = labels.indexOf('c');
            const zIdx = labels.indexOf('z');
            const tIdx = labels.indexOf('t');
            const numChannels = cIdx >= 0 ? data[0].shape[cIdx] : 1;
            const numZ = zIdx >= 0 ? data[0].shape[zIdx] : 1;
            const numT = tIdx >= 0 ? data[0].shape[tIdx] : 1;
            const omero = metadata?.omero?.channels ?? [];
            setCurrentZ(metadata?.omero?.rdefs?.defaultZ ?? 0);
            setCurrentT(metadata?.omero?.rdefs?.defaultT ?? 0);
            setChannelsVisible(
              Array.from({ length: numChannels }, (_, i) => {
                const ch = omero[i] as any;
                return ch?.channelsVisible ?? ch?.active ?? true;
              }),
            );
            setChannelColors(
              Array.from({ length: numChannels }, (_, i) => {
                const ch = omero[i];
                return ch?.color ? hexToRgb(ch.color) : FALLBACK_COLORS[i % FALLBACK_COLORS.length];
              }),
            );
            setContrastLimitsState(
              Array.from({ length: numChannels }, (_, i) => {
                const ch = omero[i];
                return ch ? [ch.window.start, ch.window.end] as [number, number] : [0, 65535] as [number, number];
              }),
            );
            setLoaded({
              viv,
              data,
              metadata,
              numChannels,
              numZ,
              numT,
              dimLabels: labels,
              deckDeps: {
                DeckGL: deckReact.default,
                OrthographicView: deckCore.OrthographicView,
              },
            });
            setPhysicalScale(extractPhysicalScale(metadata));
            setIsLoading(false);
          },
        ),
      )
      .catch((err: Error) => {
        setError(err.message);
        setIsLoading(false);
      });
  }, [source]);

  // Initial view state — wait for non-zero deck dimensions, then either apply
  // the single default view or fit to the full image.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      if (deckRef.current?.deck) {
        const { deck } = deckRef.current;
        if (deck.width > 0 && deck.height > 0) {
          const { getDefaultInitialViewState } = loaded.viv as any;
          const fitVs = getDefaultInitialViewState(loaded.data, { width: deck.width, height: deck.height }, 0);
          setFitView({ name: 'Fit to viewer', description: 'Reset zoom and center', zoom: fitVs.zoom, target: fitVs.target });

          const defaultViews = (externalViews ?? []).filter((v) => v.default);
          const initialView = defaultViews.length === 1 ? defaultViews[0] : null;

          if (initialView) {
            const vs = { ...fitVs, zoom: initialView.zoom, target: initialView.target };
            setViewState(vs);
            onViewStateChangeRef.current?.(vs);
            if (initialView.appearance) handleApplyAppearance(initialView.appearance);
            if (initialView.z !== undefined) setCurrentZ(initialView.z);
            if (initialView.t !== undefined) setCurrentT(initialView.t);
            if (initialView.playback?.startFrame !== undefined) setCurrentT(initialView.playback.startFrame);
            if (initialView.playback?.fps !== undefined) setTFps(initialView.playback.fps);
            if (initialView.playback?.playing !== undefined) setTPlaying(initialView.playback.playing);
          } else {
            setViewState(fitVs);
            onViewStateChangeRef.current?.(fitVs);
          }
          // Allow DeckGL onViewStateChange callbacks now that the initial view is set
          initialViewAppliedRef.current = true;
        } else {
          requestAnimationFrame(check);
        }
      } else {
        requestAnimationFrame(check);
      }
    };
    requestAnimationFrame(check);
    return () => { cancelled = true; };
  }, [loaded]);

  // Per-channel histograms (computed from lowest resolution for speed)
  // Recomputes when Z or T slice changes so contrast histograms reflect the active slice
  useEffect(() => {
    if (!loaded) return;
    const { data, numChannels, dimLabels } = loaded;
    const lowestRes = data[data.length - 1];
    let cancelled = false;

    Promise.all(
      Array.from({ length: numChannels }, (_, c) => {
        const sel: Record<string, number> = { c };
        if (dimLabels.includes('z')) sel.z = currentZ;
        if (dimLabels.includes('t')) sel.t = currentT;
        return lowestRes.getRaster({ selection: sel });
      }),
    ).then((rasters: any[]) => {
      if (cancelled) return;
      setHistograms(rasters.map((r: any) => computeHistogram(r.data, HIST_BINS)));
    }).catch(() => { /* histogram is optional, fail silently */ });

    return () => { cancelled = true; };
  }, [loaded, currentZ, currentT]);

  // Prefetch adjacent Z/T slices in the background after the current slice loads.
  // Skipped during playback — the playback loop itself ensures each slice loads.
  useEffect(() => {
    if (!loaded || !cachingStoreRef.current || tPlaying) return;
    const { dimLabels, numZ, numT, data } = loaded;
    const zIdx = dimLabels.indexOf('z');
    const tIdx = dimLabels.indexOf('t');
    if (zIdx < 0 && tIdx < 0) return;
    if (numZ <= 1 && numT <= 1) return;

    const dimSep: string = (data[0] as any)._data.meta?.dimension_separator || '.';
    const numDims = dimLabels.length;
    const store = cachingStoreRef.current;

    // Cancel any in-flight prefetch immediately so display requests for the
    // new slice aren't starved by stale prefetch work
    store.cancelPrefetch();

    // Brief delay so the current slice's tile requests populate the cache
    // with paths we can derive adjacent-slice paths from
    const handle = setTimeout(() => {
      store.prefetchAdjacent({
        zDimIdx: zIdx, tDimIdx: tIdx,
        currentZ, currentT,
        maxZ: numZ, maxT: numT,
        numDims, dimSep,
      });
    }, 100);
    return () => { clearTimeout(handle); store.cancelPrefetch(); };
  }, [loaded, currentZ, currentT, tPlaying]);

  // T playback — async loop that waits for each frame's tiles to load before
  // advancing, so FPS is a target rather than a mandate.  First pass through
  // uncached slices may be slower; subsequent loops play at full speed.
  useEffect(() => {
    if (!tPlaying || !loaded || loaded.numT <= 1) return;
    const numT = loaded.numT;
    const store = cachingStoreRef.current;
    let cancelled = false;

    const playLoop = async () => {
      while (!cancelled) {
        const frameStart = performance.now();

        // Advance to next T slice
        setCurrentT(prev => (prev + 1) % numT);

        if (store) {
          // Wait until tile loading settles: no new getItem calls for 50ms,
          // then wait for any in-flight network fetches to complete.
          // First pass (uncached): slower, limited by network.
          // Subsequent passes (cached): ~50ms overhead per frame.
          await store.waitForIdle(50);
          if (cancelled) return;
        }

        // Maintain target fps: wait any remaining interval time
        const elapsed = performance.now() - frameStart;
        const remaining = Math.max(0, (1000 / tFps) - elapsed);
        if (remaining > 0) {
          await new Promise<void>(r => setTimeout(r, remaining));
        }
      }
    };

    playLoop();
    return () => { cancelled = true; };
  }, [tPlaying, tFps, loaded]);

  const handleToggleChannel = useCallback((index: number) => {
    setChannelsVisible((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);

  const handleColorChange = useCallback((index: number, color: [number, number, number]) => {
    setChannelColors((prev) => {
      const next = [...(prev ?? [])];
      next[index] = color;
      return next;
    });
  }, []);

  const handleContrastChange = useCallback((index: number, limits: [number, number]) => {
    setContrastLimitsState((prev) => {
      const next = [...(prev ?? [])];
      next[index] = limits;
      return next;
    });
  }, []);

  const handleApplyAppearance = useCallback((a: SavedViewAppearance) => {
    if (a.channelsVisible) setChannelsVisible(a.channelsVisible);
    if (a.channelColors) setChannelColors(a.channelColors);
    if (a.contrastLimits) setContrastLimitsState(a.contrastLimits);
    if (a.blendMode) setBlendMode(a.blendMode);
    if (a.colormap) setColormap(a.colormap);
  }, []);

  const handleViewSelect = useCallback((v: SavedView) => {
    navigateTo(v);
    if (v.appearance) handleApplyAppearance(v.appearance);
    if (v.z !== undefined) setCurrentZ(v.z);
    if (v.t !== undefined) setCurrentT(v.t);
    if (v.playback?.startFrame !== undefined) setCurrentT(v.playback.startFrame);
    if (v.playback?.fps !== undefined) setTFps(v.playback.fps);
    // Set playing last so the interval picks up the correct fps/startFrame
    if (v.playback?.playing !== undefined) setTPlaying(v.playback.playing);
  }, [navigateTo, handleApplyAppearance]);

  const channelInfos = useMemo<ChannelInfo[]>(() => {
    if (!loaded) return [];
    const { metadata, numChannels } = loaded;
    const omeroChannels = metadata?.omero?.channels ?? [];

    const defaultContrastLimits: [number, number][] = Array.from({ length: numChannels }, (_, i) => {
      const ch = omeroChannels[i];
      return ch ? [ch.window.start, ch.window.end] : [0, 65535];
    });
    const cl = contrastLimitsState && contrastLimitsState.length === numChannels
      ? contrastLimitsState : defaultContrastLimits;

    const defaultColors: [number, number, number][] = Array.from({ length: numChannels }, (_, i) => {
      const ch = omeroChannels[i];
      return ch?.color ? hexToRgb(ch.color) : FALLBACK_COLORS[i % FALLBACK_COLORS.length];
    });
    const cols = channelColors && channelColors.length === numChannels ? channelColors : defaultColors;

    const vis = channelsVisible.length === numChannels
      ? channelsVisible : Array.from({ length: numChannels }, () => true);

    return Array.from({ length: numChannels }, (_, i) => ({
      label: omeroChannels[i]?.label ?? `Channel ${i}`,
      color: cols[i],
      visible: vis[i],
      histogram: histograms[i],
      contrastLimits: cl[i],
    }));
  }, [loaded, channelsVisible, channelColors, contrastLimitsState, histograms]);

  const menuViews = useMemo(
    () => [...(fitView ? [fitView] : []), ...(externalViews ?? [])],
    [fitView, externalViews],
  );

  // Memoize layer so it's only rebuilt when visual props change, not on every viewState tick
  const imageLayer = useMemo(() => {
    if (!loaded) return null;
    const { viv, data, metadata, numChannels, dimLabels, deckDeps } = loaded;
    const { OrthographicView } = deckDeps;
    const { MultiscaleImageLayer, ImageLayer, ColorPaletteExtension, AdditiveColormapExtension } = viv as any;

    const omeroChannels = metadata?.omero?.channels ?? [];

    const defaultContrastLimits: [number, number][] = Array.from({ length: numChannels }, (_, i) => {
      const ch = omeroChannels[i];
      return ch ? [ch.window.start, ch.window.end] : [0, 65535];
    });
    const contrastLimits = contrastLimitsState && contrastLimitsState.length === numChannels
      ? contrastLimitsState
      : defaultContrastLimits;

    const defaultColors: [number, number, number][] = Array.from({ length: numChannels }, (_, i) => {
      const ch = omeroChannels[i];
      return ch?.color ? hexToRgb(ch.color) : FALLBACK_COLORS[i % FALLBACK_COLORS.length];
    });
    const colors = channelColors && channelColors.length === numChannels ? channelColors : defaultColors;

    const visibleArr = channelsVisible.length === numChannels
      ? channelsVisible
      : Array.from({ length: numChannels }, () => true);

    const selections = Array.from({ length: numChannels }, (_, c) => {
      const sel: Record<string, number> = { c };
      if (dimLabels.includes('z')) sel.z = currentZ;
      if (dimLabels.includes('t')) sel.t = currentT;
      return sel;
    });

    const loader = data.length > 1 ? data : data[0];
    const Layer = data.length > 1 ? MultiscaleImageLayer : ImageLayer;

    const isAdditive = blendMode === 'merged';

    if (!extensionsRef.current) {
      extensionsRef.current = {
        additive: [new AdditiveColormapExtension()],
        palette: [new ColorPaletteExtension()],
      };
    }
    if (!viewsRef.current) {
      viewsRef.current = [new OrthographicView({ id: 'ortho', controller: true })];
    }

    return new Layer({
      loader,
      contrastLimits,
      colors,
      channelsVisible: visibleArr,
      selections,
      extensions: isAdditive ? extensionsRef.current.additive : extensionsRef.current.palette,
      ...(isAdditive ? { colormap } : {}),
      id: 'microatlas-image',
    });
  }, [loaded, contrastLimitsState, channelColors, channelsVisible, blendMode, colormap, currentZ, currentT]);

  const renderContent = () => {
    if (isLoading) {
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: '0.85rem' }}>
          Loading zarr&hellip;
        </div>
      );
    }

    if (error) {
      return (
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', color: '#c0392b' }}>
          <strong>Failed to load zarr</strong>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#888', fontSize: '0.75rem', marginTop: '0.5rem' }}>{error}</pre>
        </div>
      );
    }

    if (!loaded || !imageLayer) return null;

    const { deckDeps } = loaded;
    const { DeckGL } = deckDeps;

    return (
      <>
        <DeckGL
          ref={deckRef}
          layers={[imageLayer]}
          viewState={viewState && { ortho: viewState }}
          onViewStateChange={handleDeckViewStateChange}
          views={viewsRef.current}
        />
        <AnnotationOverlay
          annotations={externalAnnotations ?? []}
          visible={annotationsVisible}
          currentZ={currentZ}
          currentT={currentT}
          viewState={viewState}
          containerW={containerSize.w}
          containerH={containerSize.h}
          hoveredIdx={annotationHoveredIdx}
          pressedIdx={annotationPressedIdx}
        />
        {physicalScale && scaleBarProp && (
          <ScaleBarOverlay
            physicalScale={physicalScale}
            viewState={viewState}
            config={scaleBarConfig}
            visible={scaleBarVisible}
          />
        )}
        {titleConfig && (
          <TitleOverlay
            config={titleConfig}
            visible={titleVisible}
          />
        )}
      </>
    );
  };

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {renderContent()}
      {loaded && (
        <ViewerToolbar
          numZ={loaded.numZ}
          numT={loaded.numT}
          currentZ={currentZ}
          currentT={currentT}
          onZChange={setCurrentZ}
          onTChange={setCurrentT}
          tPlaying={tPlaying}
          tFps={tFps}
          onTPlayingChange={setTPlaying}
          onTFpsChange={setTFps}
          containerW={containerSize.w}
          menuProps={{
            containerW: containerSize.w,
            containerH: containerSize.h,
            views: menuViews,
            channels: channelInfos,
            blendMode,
            colormap,
            portalTarget: containerRef.current,
            onToggleChannel: handleToggleChannel,
            onColorChange: handleColorChange,
            onContrastChange: handleContrastChange,
            onBlendModeChange: setBlendMode,
            onColormapChange: setColormap,
            onApplyAppearance: handleApplyAppearance,
            annotationsVisible,
            onAnnotationsVisibleChange: setAnnotationsVisible,
            scaleBarVisible,
            onScaleBarVisibleChange: setScaleBarVisible,
            hasScaleBar: !!physicalScale && !!scaleBarProp,
            titleVisible,
            onTitleVisibleChange: setTitleVisible,
            hasTitle: !!titleConfig,
            navigateTo,
            onViewSelect: handleViewSelect,
          }}
        />
      )}
    </div>
  );
}
