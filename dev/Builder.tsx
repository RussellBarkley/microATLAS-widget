import { useCallback, useEffect, useRef, useState } from 'react';
import { MicroAtlasViewer, SavedView, SavedViewAppearance, Annotation, ScaleBarConfig, ScaleBarFont, TitleConfig, TitleFont } from '../src';

const WIDGET_URL = 'https://LadInTheLab.github.io/microATLAS-widget/widget.js';
const DEFAULT_SOURCE = 'https://nyu1.osn.mghpcc.org/barkley-replication/calreticulin_antibody/primary_secondary.zarr/';

const COLOR_SWATCHES: [number, number, number][] = [
  [235, 87, 87], [99, 179, 237], [104, 211, 145],
  [246, 196, 68], [176, 120, 235], [56, 224, 200],
  [237, 137, 54], [237, 100, 166], [154, 230, 96],
];

const POSITION_OPTIONS: ScaleBarConfig['position'][] = [
  'bottom-right', 'bottom-left', 'top-right', 'top-left',
];

const SCALE_BAR_FONT_OPTIONS: ScaleBarFont[] = [
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New',
];

const SCALE_BAR_COLOR_SWATCHES = [
  'rgba(255,255,255,0.9)',
  'rgba(255,255,255,0.5)',
  'rgba(0,0,0,0.85)',
  'rgb(99,179,237)',
  'rgb(104,211,145)',
  'rgb(246,196,68)',
];

const TITLE_POSITION_OPTIONS: TitleConfig['position'][] = [
  'top-center', 'top-left', 'top-right', 'bottom-center', 'bottom-left', 'bottom-right',
];

const TITLE_FONT_OPTIONS: TitleFont[] = [
  'Arial', 'Helvetica', 'Verdana', 'Trebuchet MS', 'Tahoma',
  'Georgia', 'Times New Roman', 'Palatino',
  'Courier New', 'Lucida Console',
  'Impact', 'Arial Narrow', 'Futura', 'Century Gothic',
  'Comic Sans MS',
];

const TITLE_COLOR_SWATCHES = [
  'rgba(255,255,255,0.95)',
  'rgba(255,255,255,0.60)',
  'rgba(0,0,0,0.85)',
  'rgb(99,179,237)',
  'rgb(104,211,145)',
  'rgb(246,196,68)',
  'rgb(235,87,87)',
  'rgb(176,120,235)',
];

interface Theme {
  accent: string;
  accent15: string;
  accent25: string;
  accent40: string;
  success: string;
  danger: string;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  border: string;
  borderHover: string;
  text1: string;
  text2: string;
  text3: string;
  outputText: string;
  ghostHover: string;
}

const DARK: Theme = {
  accent: 'rgb(99, 144, 240)',
  accent15: 'rgba(99, 144, 240, 0.15)',
  accent25: 'rgba(99, 144, 240, 0.25)',
  accent40: 'rgba(99, 144, 240, 0.40)',
  success: 'rgb(104, 211, 145)',
  danger: 'rgb(235, 87, 87)',
  surface0: '#0c0c0f',
  surface1: '#131318',
  surface2: '#1a1a22',
  surface3: '#22222e',
  border: 'rgba(255,255,255,0.06)',
  borderHover: 'rgba(255,255,255,0.12)',
  text1: 'rgba(255,255,255,0.92)',
  text2: 'rgba(255,255,255,0.55)',
  text3: 'rgba(255,255,255,0.30)',
  outputText: 'rgb(152, 220, 152)',
  ghostHover: 'rgba(255,255,255,0.04)',
};

const LIGHT: Theme = {
  accent: 'rgb(55, 100, 210)',
  accent15: 'rgba(55, 100, 210, 0.10)',
  accent25: 'rgba(55, 100, 210, 0.18)',
  accent40: 'rgba(55, 100, 210, 0.30)',
  success: 'rgb(34, 154, 82)',
  danger: 'rgb(210, 55, 55)',
  surface0: '#f4f5f7',
  surface1: '#ffffff',
  surface2: '#ebedf0',
  surface3: '#dde0e6',
  border: 'rgba(0,0,0,0.10)',
  borderHover: 'rgba(0,0,0,0.18)',
  text1: 'rgba(0,0,0,0.88)',
  text2: 'rgba(0,0,0,0.55)',
  text3: 'rgba(0,0,0,0.30)',
  outputText: 'rgb(30, 120, 50)',
  ghostHover: 'rgba(0,0,0,0.04)',
};

const RADIUS = 10;
const RADIUS_SM = 7;
const MONO = "'JetBrains Mono', ui-monospace, 'Cascadia Code', monospace";

function rgbStr(c: [number, number, number]) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function RulerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M4 10h3" /><path d="M4 14h5" /><path d="M4 18h3" />
    </svg>
  );
}

function TypeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function CrosshairIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="22" y1="12" x2="18" y2="12" /><line x1="6" y1="12" x2="2" y2="12" /><line x1="12" y1="6" x2="12" y2="2" /><line x1="12" y1="22" x2="12" y2="18" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function generateMarkdown(
  source: string,
  width: number,
  height: number,
  views: SavedView[],
  annotations: Annotation[],
  scaleBar: ScaleBarConfig | false,
  title: TitleConfig | false,
  defaults: { annotations: boolean; scaleBar: boolean; title: boolean },
): string {
  const config: Record<string, unknown> = {
    source,
    width: `${width}px`,
    height: `${height}px`,
  };
  if (title) config.title = title;
  if (views.length > 0) {
    config.views = views.map(({ default: d, ...rest }) => d ? { ...rest, default: true } : rest);
  }
  if (annotations.length > 0) config.annotations = annotations;
  if (scaleBar) config.scaleBar = scaleBar;
  if (!defaults.annotations) config.defaultAnnotationsVisible = false;
  if (!defaults.scaleBar) config.defaultScaleBarVisible = false;
  if (!defaults.title) config.defaultTitleVisible = false;
  const json = JSON.stringify(config, null, 2);
  return `:::{any:bundle} ${WIDGET_URL}\n${json}\n:::`;
}

function SectionHeader({ icon, label, count, t }: { icon: React.ReactNode; label: string; count?: number; t: Theme }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span style={{ color: t.text2, display: 'flex' }}>{icon}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: t.text2, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
      {count !== undefined && count > 0 && (
        <span style={{
          fontSize: 10, fontWeight: 600, color: t.accent,
          background: t.accent15, borderRadius: 10,
          padding: '1px 7px', marginLeft: 'auto',
        }}>
          {count}
        </span>
      )}
    </div>
  );
}

function ActionButton({ onClick, disabled, children, variant = 'primary', fullWidth, t }: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: 'primary' | 'ghost';
  fullWidth?: boolean;
  t: Theme;
}) {
  const isPrimary = variant === 'primary';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        width: fullWidth ? '100%' : undefined,
        background: isPrimary ? t.accent15 : 'transparent',
        border: `1px solid ${isPrimary ? t.accent40 : t.border}`,
        borderRadius: RADIUS_SM,
        padding: '7px 14px',
        fontSize: 12,
        fontWeight: 500,
        color: isPrimary ? t.accent : t.text2,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        opacity: disabled ? 0.35 : 1,
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.background = isPrimary ? t.accent25 : t.ghostHover;
          e.currentTarget.style.borderColor = isPrimary ? t.accent : t.borderHover;
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isPrimary ? t.accent15 : 'transparent';
        e.currentTarget.style.borderColor = isPrimary ? t.accent40 : t.border;
      }}
    >
      {children}
    </button>
  );
}

function TextInput({ value, onChange, onEnter, placeholder, autoFocus, mono, t }: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
  t: Theme;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onEnter ? (e) => { if (e.key === 'Enter') onEnter(); } : undefined}
      placeholder={placeholder}
      autoFocus={autoFocus}
      style={{
        width: '100%',
        background: t.surface2,
        border: `1px solid ${t.border}`,
        borderRadius: RADIUS_SM,
        padding: '8px 10px',
        fontSize: 12,
        color: t.text1,
        fontFamily: mono ? MONO : 'inherit',
        transition: 'border-color 0.15s',
      }}
      onFocus={(e) => { e.currentTarget.style.borderColor = t.accent40; }}
      onBlur={(e) => { e.currentTarget.style.borderColor = t.border; }}
    />
  );
}

function NumberInput({ value, onChange, error, t }: {
  value: number;
  onChange: (v: number) => void;
  error?: boolean;
  t: Theme;
}) {
  const [raw, setRaw] = useState(String(value));
  const [focused, setFocused] = useState(false);

  // Sync from parent when not focused (e.g. external reset)
  useEffect(() => {
    if (!focused) setRaw(String(value));
  }, [value, focused]);

  const borderColor = error ? t.danger : t.border;
  return (
    <input
      type="text"
      inputMode="numeric"
      value={raw}
      onChange={(e) => {
        const v = e.target.value;
        setRaw(v);
        const n = Number(v);
        if (v !== '' && !isNaN(n)) onChange(n);
      }}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.style.borderColor = error ? t.danger : t.accent40;
      }}
      onBlur={(e) => {
        setFocused(false);
        // Commit: if empty or invalid, revert to parent value
        const n = Number(raw);
        if (raw === '' || isNaN(n)) {
          setRaw(String(value));
        } else {
          onChange(n);
          setRaw(String(n));
        }
        e.currentTarget.style.borderColor = borderColor;
      }}
      style={{
        width: '100%',
        background: error ? 'rgba(235,87,87,0.06)' : t.surface2,
        border: `1px solid ${borderColor}`,
        borderRadius: RADIUS_SM,
        padding: '8px 10px',
        fontSize: 12,
        color: t.text1,
        fontFamily: MONO,
        textAlign: 'center',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    />
  );
}

function EditableTag({ value, onChange, min, max, prefix, suffix, t }: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  prefix?: string;
  suffix?: string;
  t: Theme;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(String(value));

  if (editing) {
    return (
      <input
        type="number"
        autoFocus
        value={raw}
        min={min}
        max={max}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          const n = parseInt(raw);
          if (!isNaN(n)) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 32, background: t.surface2, border: `1px solid ${t.accent40}`,
          borderRadius: 3, padding: '0 2px', fontSize: 9, color: t.text1,
          textAlign: 'center', outline: 'none', marginLeft: 2,
        }}
      />
    );
  }

  return (
    <span
      onClick={(e) => { e.stopPropagation(); setRaw(String(value)); setEditing(true); }}
      title="Click to edit"
      style={{ cursor: 'pointer', borderBottom: `1px dashed ${t.text3}`, marginLeft: 3 }}
    >
      {prefix}{value}{suffix}
    </span>
  );
}

function ListItem({ children, onDelete, t }: { children: React.ReactNode; onDelete: () => void; t: Theme }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 8px',
      borderRadius: RADIUS_SM,
      background: t.surface2,
      marginBottom: 4,
      transition: 'background 0.12s',
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = t.surface3; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = t.surface2; }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        {children}
      </div>
      <button
        onClick={onDelete}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: t.text3,
          padding: 4,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          transition: 'color 0.15s, background 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = t.danger; e.currentTarget.style.background = 'rgba(235,87,87,0.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = t.text3; e.currentTarget.style.background = 'none'; }}
        title="Remove"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, t }: { checked: boolean; onChange: (v: boolean) => void; t: Theme }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        border: 'none',
        background: checked ? t.accent : t.surface3,
        cursor: 'pointer',
        position: 'relative',
        transition: 'background 0.2s ease',
        flexShrink: 0,
        padding: 0,
      }}
    >
      <div style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        background: '#fff',
        position: 'absolute',
        top: 3,
        left: checked ? 19 : 3,
        transition: 'left 0.2s ease',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }} />
    </button>
  );
}

export function Builder() {
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem('builder-theme') !== 'light'; } catch { return true; }
  });
  const t = isDark ? DARK : LIGHT;

  useEffect(() => {
    try { localStorage.setItem('builder-theme', isDark ? 'dark' : 'light'); } catch {}
  }, [isDark]);

  const [urlInput, setUrlInput] = useState(DEFAULT_SOURCE);
  const [source, setSource] = useState(DEFAULT_SOURCE);

  const [viewerWidth, setViewerWidth] = useState(500);
  const [viewerHeight, setViewerHeight] = useState(500);
  const [views, setViews] = useState<SavedView[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [scaleBarEnabled, setScaleBarEnabled] = useState(false);
  const [scaleBarMaxWidth, setScaleBarMaxWidth] = useState(100);
  const [scaleBarPosition, setScaleBarPosition] = useState<ScaleBarConfig['position']>('bottom-right');
  const [scaleBarFontSize, setScaleBarFontSize] = useState(10);
  const [scaleBarFont, setScaleBarFont] = useState<ScaleBarFont>('Arial');
  const [scaleBarColor, setScaleBarColor] = useState(SCALE_BAR_COLOR_SWATCHES[0]);

  const [titleEnabled, setTitleEnabled] = useState(false);
  const [titleText, setTitleText] = useState('');
  const [titlePosition, setTitlePosition] = useState<TitleConfig['position']>('top-center');
  const [titleMargin, setTitleMargin] = useState(12);
  const [titleFontSize, setTitleFontSize] = useState(24);
  const [titleFont, setTitleFont] = useState<TitleFont>('Arial');
  const [titleColor, setTitleColor] = useState(TITLE_COLOR_SWATCHES[0]);
  const [titleStyle, setTitleStyle] = useState<'text' | 'pill'>('text');

  const [defaultAnnotationsVisible, setDefaultAnnotationsVisible] = useState(true);
  const [defaultScaleBarVisible, setDefaultScaleBarVisible] = useState(true);
  const [defaultTitleVisible, setDefaultTitleVisible] = useState(true);

  const viewStateRef = useRef<{ zoom: number; target: [number, number, number] } | null>(null);
  const [hasViewState, setHasViewState] = useState(false);
  const handleViewStateChange = useCallback((vs: { zoom: number; target: [number, number, number] }) => {
    viewStateRef.current = vs;
    if (!hasViewState) setHasViewState(true);
  }, [hasViewState]);

  const appearanceRef = useRef<SavedViewAppearance | null>(null);
  const handleAppearanceChange = useCallback((a: SavedViewAppearance) => {
    appearanceRef.current = a;
  }, []);

  const sliceRef = useRef<{ z: number; t: number; playing: boolean; fps: number; numZ: number; numT: number } | null>(null);
  const handleSliceChange = useCallback((s: { z: number; t: number; playing: boolean; fps: number; numZ: number; numT: number }) => {
    sliceRef.current = s;
  }, []);

  const [captureFormOpen, setCaptureFormOpen] = useState(false);
  const [captureName, setCaptureName] = useState('');
  const [captureDesc, setCaptureDesc] = useState('');
  const [captureAppearance, setCaptureAppearance] = useState(true);
  const [captureSlice, setCaptureSlice] = useState(true);
  const [capturePlayback, setCapturePlayback] = useState(false);
  const [captureFps, setCaptureFps] = useState(5);
  const [captureStartFrame, setCaptureStartFrame] = useState(0);

  const [annotationFormOpen, setAnnotationFormOpen] = useState(false);
  const [annotationName, setAnnotationName] = useState('');
  const [annotationColor, setAnnotationColor] = useState<[number, number, number]>(COLOR_SWATCHES[0]);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationLockZ, setAnnotationLockZ] = useState(true);
  const [annotationLockT, setAnnotationLockT] = useState(true);

  const [copied, setCopied] = useState(false);
  const viewerContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!annotationMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAnnotationMode(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [annotationMode]);

  const scaleBar: ScaleBarConfig | false = scaleBarEnabled
    ? { maxWidth: scaleBarMaxWidth, position: scaleBarPosition, fontSize: scaleBarFontSize, font: scaleBarFont, color: scaleBarColor }
    : false;

  const titleConfig: TitleConfig | false = titleEnabled && titleText.trim()
    ? { text: titleText.trim(), position: titlePosition, margin: titleMargin, fontSize: titleFontSize, font: titleFont, color: titleColor, style: titleStyle }
    : false;

  const widthValid = viewerWidth >= 100 && viewerWidth <= 2000;
  const heightValid = viewerHeight >= 100 && viewerHeight <= 2000;
  const sizeValid = widthValid && heightValid;

  const scaleBarMaxWidthValid = scaleBarMaxWidth >= 40 && scaleBarMaxWidth <= 300;
  const scaleBarFontSizeValid = scaleBarFontSize >= 6 && scaleBarFontSize <= 48;
  const titleFontSizeValid = titleFontSize >= 8 && titleFontSize <= 120;
  const titleMarginValid = titleMargin >= 0 && titleMargin <= 200;

  const markdown = sizeValid
    ? generateMarkdown(source, viewerWidth, viewerHeight, views, annotations, scaleBar, titleConfig, {
        annotations: defaultAnnotationsVisible,
        scaleBar: defaultScaleBarVisible,
        title: defaultTitleVisible,
      })
    : '// Fix widget size errors above';

  const handleLoad = () => {
    const trimmed = urlInput.trim();
    if (trimmed && trimmed !== source) {
      setSource(trimmed);
      setViews([]);
      setAnnotations([]);
      viewStateRef.current = null;
      setHasViewState(false);
    }
  };

  const handleCaptureView = () => {
    const vs = viewStateRef.current;
    if (!vs || !captureName.trim()) return;
    const sl = sliceRef.current;
    const view: SavedView = {
      name: captureName.trim(),
      ...(captureDesc.trim() ? { description: captureDesc.trim() } : {}),
      zoom: Math.round(vs.zoom * 1000) / 1000,
      target: [Math.round(vs.target[0]), Math.round(vs.target[1]), 0],
      ...(captureAppearance && appearanceRef.current ? { appearance: appearanceRef.current } : {}),
      ...(captureSlice && sl && sl.numZ > 1 ? { z: sl.z } : {}),
      ...(captureSlice && sl && sl.numT > 1 ? { t: sl.t } : {}),
      ...(capturePlayback && sl && sl.numT > 1 ? { playback: { playing: sl.playing, fps: captureFps, startFrame: captureStartFrame } } : {}),
    };
    setViews((prev) => [...prev, view]);
    setCaptureName('');
    setCaptureDesc('');
    setCaptureFormOpen(false);
  };

  const handleStartAnnotationPlace = () => {
    if (!annotationName.trim()) return;
    setAnnotationMode(true);
  };

  const handleViewerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const vs = viewStateRef.current;
    if (!annotationMode || !vs || !viewerContainerRef.current) return;
    const rect = viewerContainerRef.current.getBoundingClientRect();
    const scale = Math.pow(2, vs.zoom);
    const imageX = Math.round((e.clientX - rect.left - rect.width / 2) / scale + vs.target[0]);
    const imageY = Math.round((e.clientY - rect.top - rect.height / 2) / scale + vs.target[1]);
    const sl = sliceRef.current;
    const annotation: Annotation = {
      name: annotationName.trim(),
      target: [imageX, imageY],
      color: annotationColor,
      ...(annotationLockZ && sl && sl.numZ > 1 ? { z: sl.z } : {}),
      ...(annotationLockT && sl && sl.numT > 1 ? { t: sl.t } : {}),
    };
    setAnnotations((prev) => [...prev, annotation]);
    setAnnotationMode(false);
    setAnnotationName('');
    setAnnotationFormOpen(false);
  }, [annotationMode, annotationName, annotationColor, annotationLockZ, annotationLockT]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: t.surface0 }}>

      {/* ─── Header ─── */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '12px 20px',
        borderBottom: `1px solid ${t.border}`,
        flexShrink: 0,
        background: t.surface1,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: `linear-gradient(135deg, ${t.accent}, #a78bfa)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 700, color: '#fff',
            boxShadow: '0 2px 8px rgba(99,144,240,0.3)',
          }}>
            m
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: t.text1, letterSpacing: '-0.02em', lineHeight: 1 }}>
              microATLAS
            </div>
            <div style={{ fontSize: 9, fontWeight: 500, color: t.text3, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 1 }}>
              Widget Builder
            </div>
          </div>
        </div>

        <div style={{ width: 1, height: 24, background: t.border, flexShrink: 0 }} />

        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          background: t.surface2,
          border: `1px solid ${t.border}`,
          borderRadius: RADIUS_SM,
          padding: '0 4px 0 12px',
          transition: 'border-color 0.15s',
        }}
          onFocus={(e) => { e.currentTarget.style.borderColor = t.accent40; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = t.border; }}
        >
          <span style={{ fontSize: 11, color: t.text3, whiteSpace: 'nowrap', marginRight: 6 }}>Source</span>
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleLoad(); }}
            placeholder="https://your-bucket.s3.amazonaws.com/data.zarr/"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              padding: '9px 4px',
              fontSize: 12,
              color: t.text1,
              fontFamily: MONO,
              minWidth: 0,
            }}
          />
          <button
            onClick={handleLoad}
            style={{
              background: t.accent,
              border: 'none',
              borderRadius: 5,
              padding: '6px 14px',
              fontSize: 11,
              fontWeight: 600,
              color: '#fff',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'opacity 0.15s',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          >
            Load
          </button>
        </div>

        <button
          onClick={() => setIsDark((d) => !d)}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            background: 'transparent',
            border: `1px solid ${t.border}`,
            borderRadius: RADIUS_SM,
            padding: '6px 8px',
            cursor: 'pointer',
            color: t.text2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.borderHover; e.currentTarget.style.color = t.text1; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.color = t.text2; }}
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>

      {/* ─── Main ─── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        <div style={{
          flex: 1,
          overflow: 'auto',
          background: `radial-gradient(ellipse at center, ${t.surface2} 0%, ${t.surface0} 70%)`,
          minWidth: 0,
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            padding: 48,
            minHeight: '100%',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <div
                ref={viewerContainerRef}
                style={{
                  width: viewerWidth,
                  height: viewerHeight,
                  flexShrink: 0,
                  position: 'relative',
                  background: '#000',
                  borderRadius: RADIUS + 2,
                  overflow: 'hidden',
                  border: `1px solid rgba(255,255,255,0.06)`,
                  boxShadow: '0 4px 24px rgba(0,0,0,0.4), 0 12px 48px rgba(0,0,0,0.2)',
                }}
              >
                {source && (
                  <MicroAtlasViewer
                    key={source}
                    source={source}
                    views={views}
                    annotations={annotations}
                    scaleBar={scaleBar || undefined}
                    title={titleConfig || undefined}
                    defaultAnnotationsVisible={defaultAnnotationsVisible}
                    defaultScaleBarVisible={defaultScaleBarVisible}
                    defaultTitleVisible={defaultTitleVisible}
                    onViewStateChange={handleViewStateChange}
                    onAppearanceChange={handleAppearanceChange}
                    onSliceChange={handleSliceChange}
                  />
                )}
                {annotationMode && (
                  <div
                    onClick={handleViewerClick}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      cursor: 'crosshair',
                      zIndex: 20,
                      background: 'rgba(99,144,240,0.04)',
                      borderRadius: RADIUS + 2,
                    }}
                  >
                    <div style={{
                      position: 'absolute',
                      top: 14,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      background: 'rgba(12,12,15,0.92)',
                      border: `1px solid ${t.accent40}`,
                      borderRadius: RADIUS,
                      padding: '8px 16px',
                      fontSize: 12,
                      fontWeight: 500,
                      color: t.accent,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      backdropFilter: 'blur(12px)',
                      whiteSpace: 'nowrap',
                      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
                    }}>
                      <CrosshairIcon />
                      Click to place "{annotationName}"
                      <span style={{ color: t.text3, fontSize: 11 }}>Esc to cancel</span>
                    </div>
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: t.text3, fontFamily: MONO }}>
                {viewerWidth} x {viewerHeight}
              </span>
            </div>
          </div>
        </div>

        {/* ─── Tools sidebar ─── */}
        <div style={{
          width: 300,
          flexShrink: 0,
          borderLeft: `1px solid ${t.border}`,
          background: t.surface1,
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
        }}>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>

            <div style={{ marginBottom: 16 }}>
              <SectionHeader icon={<MaximizeIcon />} label="Widget Size" t={t} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: widthValid ? t.text3 : t.danger, marginBottom: 4 }}>Width</div>
                  <NumberInput value={viewerWidth} onChange={setViewerWidth} error={!widthValid} t={t} />
                </div>
                <span style={{ fontSize: 12, color: t.text3, marginTop: 16 }}>x</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: heightValid ? t.text3 : t.danger, marginBottom: 4 }}>Height</div>
                  <NumberInput value={viewerHeight} onChange={setViewerHeight} error={!heightValid} t={t} />
                </div>
              </div>
              {!sizeValid && (
                <div style={{ fontSize: 10, color: t.danger, marginTop: 6 }}>
                  Must be between 100 and 2000
                </div>
              )}
            </div>

            <div style={{ height: 1, background: t.border, margin: '0 -16px 16px' }} />

            <div style={{ marginBottom: 16 }}>
              <SectionHeader icon={<CameraIcon />} label="Saved Views" count={views.length} t={t} />
              {views.map((v, i) => (
                <ListItem key={i} onDelete={() => setViews((p) => p.filter((_, j) => j !== i))} t={t}>
                  <button
                    onClick={() => setViews((p) => p.map((view, j) => ({
                      ...view,
                      default: j === i ? !view.default : false,
                    })))}
                    title={v.default ? 'Remove as default view' : 'Set as default view'}
                    style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      border: `1.5px solid ${v.default ? t.accent : t.text3}`,
                      background: v.default ? t.accent : 'transparent',
                      cursor: 'pointer', padding: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {v.default && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: t.text1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.name}
                      {v.default && (
                        <span style={{ fontSize: 9, color: t.accent, marginLeft: 6, fontWeight: 600 }}>default</span>
                      )}
                      {v.appearance && (
                        <span style={{ fontSize: 9, color: t.text3, marginLeft: 6, fontWeight: 400 }}>+ appearance</span>
                      )}
                      {v.z !== undefined && (
                        <span style={{ fontSize: 9, color: t.text3, marginLeft: 6, fontWeight: 400 }}>Z:{v.z}</span>
                      )}
                      {v.t !== undefined && (
                        <span style={{ fontSize: 9, color: t.text3, marginLeft: 6, fontWeight: 400 }}>T:{v.t}</span>
                      )}
                      {v.playback && (
                        <span style={{ fontSize: 9, color: t.text3, marginLeft: 6, fontWeight: 400 }}>
                          {v.playback.playing ? '▶' : '⏸'}
                          {v.playback.fps !== undefined && (
                            <EditableTag
                              value={v.playback.fps}
                              suffix="fps"
                              min={1}
                              max={60}
                              onChange={(val) => setViews((p) => p.map((vw, j) => j === i ? { ...vw, playback: { ...vw.playback!, fps: val } } : vw))}
                              t={t}
                            />
                          )}
                          {v.playback.startFrame !== undefined && (
                            <EditableTag
                              value={v.playback.startFrame}
                              prefix="@"
                              min={0}
                              max={sliceRef.current ? sliceRef.current.numT - 1 : 999}
                              onChange={(val) => setViews((p) => p.map((vw, j) => j === i ? { ...vw, playback: { ...vw.playback!, startFrame: val } } : vw))}
                              t={t}
                            />
                          )}
                        </span>
                      )}
                    </div>
                    {v.description && (
                      <div style={{ fontSize: 10, color: t.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{v.description}</div>
                    )}
                  </div>
                </ListItem>
              ))}
              {captureFormOpen ? (
                <div style={{ background: t.surface2, borderRadius: RADIUS_SM, padding: 10, marginTop: 4 }}>
                  <div style={{ marginBottom: 6 }}>
                    <TextInput value={captureName} onChange={setCaptureName} onEnter={handleCaptureView} placeholder="View name" autoFocus t={t} />
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <TextInput value={captureDesc} onChange={setCaptureDesc} onEnter={handleCaptureView} placeholder="Description (optional)" t={t} />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer', fontSize: 12, color: t.text2 }}>
                    <input
                      type="checkbox"
                      checked={captureAppearance}
                      onChange={(e) => setCaptureAppearance(e.target.checked)}
                      style={{ accentColor: t.accent }}
                    />
                    Save appearance
                  </label>
                  {sliceRef.current && (sliceRef.current.numZ > 1 || sliceRef.current.numT > 1) && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer', fontSize: 12, color: t.text2 }}>
                      <input
                        type="checkbox"
                        checked={captureSlice}
                        onChange={(e) => setCaptureSlice(e.target.checked)}
                        style={{ accentColor: t.accent }}
                      />
                      Save Z/T position
                      <span style={{ fontSize: 10, color: t.text3 }}>
                        {sliceRef.current.numZ > 1 ? `Z:${sliceRef.current.z + 1}` : ''}{sliceRef.current.numZ > 1 && sliceRef.current.numT > 1 ? ' ' : ''}{sliceRef.current.numT > 1 ? `T:${sliceRef.current.t + 1}` : ''}
                      </span>
                    </label>
                  )}
                  {sliceRef.current && sliceRef.current.numT > 1 && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: capturePlayback ? 6 : 4, cursor: 'pointer', fontSize: 12, color: t.text2 }}>
                        <input
                          type="checkbox"
                          checked={capturePlayback}
                          onChange={(e) => {
                            setCapturePlayback(e.target.checked);
                            if (e.target.checked && sliceRef.current) {
                              setCaptureFps(sliceRef.current.fps);
                              setCaptureStartFrame(sliceRef.current.t);
                            }
                          }}
                          style={{ accentColor: t.accent }}
                        />
                        Save playback state
                      </label>
                      {capturePlayback && (
                        <div style={{ display: 'flex', gap: 10, marginBottom: 6, marginLeft: 26, alignItems: 'center' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: t.text3 }}>
                            FPS
                            <input
                              type="number"
                              min={1}
                              max={60}
                              value={captureFps}
                              onChange={(e) => setCaptureFps(Math.max(1, Math.min(60, parseInt(e.target.value) || 1)))}
                              style={{
                                width: 42, background: t.surface2, border: `1px solid ${t.border}`,
                                borderRadius: 4, padding: '2px 4px', fontSize: 11, color: t.text1,
                                textAlign: 'center', outline: 'none',
                              }}
                            />
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: t.text3 }}>
                            Start
                            <input
                              type="number"
                              min={0}
                              max={sliceRef.current!.numT - 1}
                              value={captureStartFrame}
                              onChange={(e) => setCaptureStartFrame(Math.max(0, Math.min(sliceRef.current!.numT - 1, parseInt(e.target.value) || 0)))}
                              style={{
                                width: 42, background: t.surface2, border: `1px solid ${t.border}`,
                                borderRadius: 4, padding: '2px 4px', fontSize: 11, color: t.text1,
                                textAlign: 'center', outline: 'none',
                              }}
                            />
                            <span style={{ fontSize: 10, color: t.text3 }}>/ {sliceRef.current!.numT}</span>
                          </label>
                        </div>
                      )}
                    </>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <ActionButton onClick={handleCaptureView} disabled={!captureName.trim() || !hasViewState} t={t}>Save</ActionButton>
                    <ActionButton onClick={() => { setCaptureFormOpen(false); setCaptureName(''); setCaptureDesc(''); }} variant="ghost" t={t}>Cancel</ActionButton>
                  </div>
                </div>
              ) : (
                <ActionButton onClick={() => setCaptureFormOpen(true)} disabled={!hasViewState} fullWidth t={t}>
                  <CameraIcon /> Capture Current View
                </ActionButton>
              )}
            </div>

            <div style={{ height: 1, background: t.border, margin: '0 -16px 16px' }} />

            <div style={{ marginBottom: 16 }}>
              <SectionHeader icon={<PinIcon />} label="Annotations" count={annotations.length} t={t} />
              {annotations.map((a, i) => (
                <ListItem key={i} onDelete={() => setAnnotations((p) => p.filter((_, j) => j !== i))} t={t}>
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: rgbStr(a.color ?? [235, 87, 87]),
                    flexShrink: 0,
                    boxShadow: `0 0 6px ${rgbStr(a.color ?? [235, 87, 87])}40`,
                  }} />
                  <span style={{ fontSize: 12, fontWeight: 500, color: t.text1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.name}
                    {a.z !== undefined ? (
                      <EditableTag
                        value={a.z}
                        prefix="Z:"
                        min={0}
                        max={sliceRef.current ? sliceRef.current.numZ - 1 : 999}
                        onChange={(val) => setAnnotations((p) => p.map((ann, j) => j === i ? { ...ann, z: val } : ann))}
                        t={t}
                      />
                    ) : sliceRef.current && sliceRef.current.numZ > 1 ? (
                      <span style={{ fontSize: 9, color: t.text3, marginLeft: 6, fontWeight: 400 }}>All Z</span>
                    ) : null}
                    {a.t !== undefined ? (
                      <EditableTag
                        value={a.t}
                        prefix="T:"
                        min={0}
                        max={sliceRef.current ? sliceRef.current.numT - 1 : 999}
                        onChange={(val) => setAnnotations((p) => p.map((ann, j) => j === i ? { ...ann, t: val } : ann))}
                        t={t}
                      />
                    ) : sliceRef.current && sliceRef.current.numT > 1 ? (
                      <span style={{ fontSize: 9, color: t.text3, marginLeft: 6, fontWeight: 400 }}>All T</span>
                    ) : null}
                  </span>
                </ListItem>
              ))}
              {annotationFormOpen && !annotationMode ? (
                <div style={{ background: t.surface2, borderRadius: RADIUS_SM, padding: 10, marginTop: 4 }}>
                  <div style={{ marginBottom: 8 }}>
                    <TextInput value={annotationName} onChange={setAnnotationName} onEnter={handleStartAnnotationPlace} placeholder="Annotation name" autoFocus t={t} />
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
                    {COLOR_SWATCHES.map((c, i) => {
                      const selected = c[0] === annotationColor[0] && c[1] === annotationColor[1] && c[2] === annotationColor[2];
                      return (
                        <button
                          key={i}
                          onClick={() => setAnnotationColor(c)}
                          style={{
                            width: 22, height: 22, borderRadius: 6,
                            border: selected ? '2px solid #fff' : `1px solid ${t.border}`,
                            background: rgbStr(c),
                            cursor: 'pointer',
                            padding: 0,
                            transform: selected ? 'scale(1.15)' : 'scale(1)',
                            transition: 'transform 0.12s, box-shadow 0.12s',
                            boxShadow: selected ? `0 0 8px ${rgbStr(c)}60` : 'none',
                          }}
                        />
                      );
                    })}
                  </div>
                  {sliceRef.current && sliceRef.current.numZ > 1 && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer', fontSize: 12, color: t.text2 }}>
                      <input
                        type="checkbox"
                        checked={annotationLockZ}
                        onChange={(e) => setAnnotationLockZ(e.target.checked)}
                        style={{ accentColor: t.accent }}
                      />
                      Lock to Z slice
                      <span style={{ fontSize: 10, color: t.text3 }}>
                        {annotationLockZ ? `Z:${sliceRef.current.z + 1}` : 'All'}
                      </span>
                    </label>
                  )}
                  {sliceRef.current && sliceRef.current.numT > 1 && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer', fontSize: 12, color: t.text2 }}>
                      <input
                        type="checkbox"
                        checked={annotationLockT}
                        onChange={(e) => setAnnotationLockT(e.target.checked)}
                        style={{ accentColor: t.accent }}
                      />
                      Lock to T slice
                      <span style={{ fontSize: 10, color: t.text3 }}>
                        {annotationLockT ? `T:${sliceRef.current.t + 1}` : 'All'}
                      </span>
                    </label>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <ActionButton onClick={handleStartAnnotationPlace} disabled={!annotationName.trim() || !hasViewState} t={t}>
                      <CrosshairIcon /> Place on Image
                    </ActionButton>
                    <ActionButton onClick={() => { setAnnotationFormOpen(false); setAnnotationName(''); }} variant="ghost" t={t}>Cancel</ActionButton>
                  </div>
                </div>
              ) : !annotationMode ? (
                <ActionButton onClick={() => setAnnotationFormOpen(true)} disabled={!hasViewState} fullWidth t={t}>
                  <PinIcon /> Add Annotation
                </ActionButton>
              ) : (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: RADIUS_SM,
                  background: t.accent15,
                  border: `1px solid ${t.accent40}`,
                  marginTop: 4,
                }}>
                  <CrosshairIcon />
                  <span style={{ fontSize: 11, color: t.accent, fontWeight: 500 }}>Click on the image...</span>
                </div>
              )}
            </div>

            <div style={{ height: 1, background: t.border, margin: '0 -16px 16px' }} />

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ color: t.text2, display: 'flex' }}><RulerIcon /></span>
                <span style={{ fontSize: 11, fontWeight: 600, color: t.text2, letterSpacing: '0.04em', textTransform: 'uppercase', flex: 1 }}>Scale Bar</span>
                <ToggleSwitch checked={scaleBarEnabled} onChange={setScaleBarEnabled} t={t} />
              </div>
              {scaleBarEnabled && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 22 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: t.text2, whiteSpace: 'nowrap', width: 60 }}>Max width</span>
                    <div style={{ width: 70 }}>
                      <NumberInput value={scaleBarMaxWidth} onChange={setScaleBarMaxWidth} error={!scaleBarMaxWidthValid} t={t} />
                    </div>
                    <span style={{ fontSize: 11, color: t.text3 }}>px</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: t.text2, whiteSpace: 'nowrap', width: 60 }}>Position</span>
                    <select
                      value={scaleBarPosition}
                      onChange={(e) => setScaleBarPosition(e.target.value as ScaleBarConfig['position'])}
                      style={{
                        flex: 1,
                        background: t.surface2,
                        border: `1px solid ${t.border}`,
                        borderRadius: RADIUS_SM,
                        padding: '7px 10px',
                        fontSize: 12,
                        color: t.text1,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        transition: 'border-color 0.15s',
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = t.accent40; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = t.border; }}
                    >
                      {POSITION_OPTIONS.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: scaleBarFontSizeValid ? t.text2 : t.danger, whiteSpace: 'nowrap', width: 60 }}>Text size</span>
                    <div style={{ width: 70 }}>
                      <NumberInput value={scaleBarFontSize} onChange={setScaleBarFontSize} error={!scaleBarFontSizeValid} t={t} />
                    </div>
                    <span style={{ fontSize: 11, color: t.text3 }}>px</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: t.text2, whiteSpace: 'nowrap', width: 60 }}>Font</span>
                    <select
                      value={scaleBarFont}
                      onChange={(e) => setScaleBarFont(e.target.value as ScaleBarFont)}
                      style={{
                        flex: 1,
                        background: t.surface2,
                        border: `1px solid ${t.border}`,
                        borderRadius: RADIUS_SM,
                        padding: '7px 10px',
                        fontSize: 12,
                        color: t.text1,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        transition: 'border-color 0.15s',
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = t.accent40; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = t.border; }}
                    >
                      {SCALE_BAR_FONT_OPTIONS.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: t.text3, marginBottom: 4 }}>Color</div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {SCALE_BAR_COLOR_SWATCHES.map((c) => {
                        const selected = c === scaleBarColor;
                        return (
                          <button
                            key={c}
                            onClick={() => setScaleBarColor(c)}
                            style={{
                              width: 22, height: 22, borderRadius: 6,
                              border: selected ? '2px solid #fff' : `1px solid ${t.border}`,
                              background: c,
                              cursor: 'pointer',
                              padding: 0,
                              transform: selected ? 'scale(1.15)' : 'scale(1)',
                              transition: 'transform 0.12s, box-shadow 0.12s',
                              boxShadow: selected ? `0 0 8px rgba(255,255,255,0.3)` : 'none',
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, color: t.text2, marginTop: 2 }}>
                    <input type="checkbox" checked={defaultScaleBarVisible} onChange={(e) => setDefaultScaleBarVisible(e.target.checked)} style={{ accentColor: t.accent }} />
                    Visible by default
                  </label>
                </div>
              )}
            </div>

            <div style={{ height: 1, background: t.border, margin: '0 -16px 16px' }} />

            {/* ─── Title ─── */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ color: t.text2, display: 'flex' }}><TypeIcon /></span>
                <span style={{ fontSize: 11, fontWeight: 600, color: t.text2, letterSpacing: '0.04em', textTransform: 'uppercase', flex: 1 }}>Title</span>
                <ToggleSwitch checked={titleEnabled} onChange={setTitleEnabled} t={t} />
              </div>
              {titleEnabled && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 22 }}>
                  <div>
                    <div style={{ fontSize: 10, color: t.text3, marginBottom: 4 }}>Text</div>
                    <TextInput value={titleText} onChange={setTitleText} placeholder="Enter title text" t={t} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: t.text2, whiteSpace: 'nowrap', width: 60 }}>Style</span>
                    <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                      {(['text', 'pill'] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => setTitleStyle(s)}
                          style={{
                            flex: 1,
                            padding: '6px 0',
                            fontSize: 11,
                            fontWeight: 500,
                            fontFamily: 'inherit',
                            color: titleStyle === s ? t.accent : t.text2,
                            background: titleStyle === s ? t.accent15 : t.surface2,
                            border: `1px solid ${titleStyle === s ? t.accent40 : t.border}`,
                            borderRadius: RADIUS_SM,
                            cursor: 'pointer',
                            transition: 'all 0.15s',
                            textTransform: 'capitalize',
                          }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: t.text2, whiteSpace: 'nowrap', width: 60 }}>Position</span>
                    <select
                      value={titlePosition}
                      onChange={(e) => setTitlePosition(e.target.value as TitleConfig['position'])}
                      style={{
                        flex: 1,
                        background: t.surface2,
                        border: `1px solid ${t.border}`,
                        borderRadius: RADIUS_SM,
                        padding: '7px 10px',
                        fontSize: 12,
                        color: t.text1,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        transition: 'border-color 0.15s',
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = t.accent40; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = t.border; }}
                    >
                      {TITLE_POSITION_OPTIONS.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: titleFontSizeValid ? t.text2 : t.danger, whiteSpace: 'nowrap', width: 60 }}>Size</span>
                    <div style={{ width: 70 }}>
                      <NumberInput value={titleFontSize} onChange={setTitleFontSize} error={!titleFontSizeValid} t={t} />
                    </div>
                    <span style={{ fontSize: 11, color: t.text3 }}>px</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: titleMarginValid ? t.text2 : t.danger, whiteSpace: 'nowrap', width: 60 }}>Margin</span>
                    <div style={{ width: 70 }}>
                      <NumberInput value={titleMargin} onChange={setTitleMargin} error={!titleMarginValid} t={t} />
                    </div>
                    <span style={{ fontSize: 11, color: t.text3 }}>px</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: t.text2, whiteSpace: 'nowrap', width: 60 }}>Font</span>
                    <select
                      value={titleFont}
                      onChange={(e) => setTitleFont(e.target.value as TitleFont)}
                      style={{
                        flex: 1,
                        background: t.surface2,
                        border: `1px solid ${t.border}`,
                        borderRadius: RADIUS_SM,
                        padding: '7px 10px',
                        fontSize: 12,
                        color: t.text1,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        transition: 'border-color 0.15s',
                      }}
                      onFocus={(e) => { e.currentTarget.style.borderColor = t.accent40; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = t.border; }}
                    >
                      {TITLE_FONT_OPTIONS.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: t.text3, marginBottom: 4 }}>Color</div>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {TITLE_COLOR_SWATCHES.map((c) => {
                        const selected = c === titleColor;
                        return (
                          <button
                            key={c}
                            onClick={() => setTitleColor(c)}
                            style={{
                              width: 22, height: 22, borderRadius: 6,
                              border: selected ? '2px solid #fff' : `1px solid ${t.border}`,
                              background: c,
                              cursor: 'pointer',
                              padding: 0,
                              transform: selected ? 'scale(1.15)' : 'scale(1)',
                              transition: 'transform 0.12s, box-shadow 0.12s',
                              boxShadow: selected ? `0 0 8px rgba(255,255,255,0.3)` : 'none',
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, color: t.text2, marginTop: 2 }}>
                    <input type="checkbox" checked={defaultTitleVisible} onChange={(e) => setDefaultTitleVisible(e.target.checked)} style={{ accentColor: t.accent }} />
                    Visible by default
                  </label>
                </div>
              )}
            </div>

            <div style={{ height: 1, background: t.border, margin: '0 -16px 16px' }} />

            {/* ─── Default Visibility ─── */}
            {annotations.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: t.text3, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>
                  Default Visibility
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, color: t.text2, paddingLeft: 22 }}>
                  <input type="checkbox" checked={defaultAnnotationsVisible} onChange={(e) => setDefaultAnnotationsVisible(e.target.checked)} style={{ accentColor: t.accent }} />
                  Annotations visible by default
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Output bar ─── */}
      <div style={{
        flexShrink: 0,
        borderTop: `1px solid ${t.border}`,
        display: 'flex',
        alignItems: 'stretch',
        background: t.surface1,
      }}>
        <div style={{
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          borderRight: `1px solid ${t.border}`,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: t.text3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Output</span>
        </div>
        <pre style={{
          flex: 1,
          margin: 0,
          padding: '10px 16px',
          fontSize: 11.5,
          lineHeight: 1.6,
          color: t.outputText,
          background: t.surface0,
          overflowX: 'auto',
          overflowY: 'auto',
          maxHeight: 180,
          whiteSpace: 'pre',
          fontFamily: MONO,
        }}>
          {markdown}
        </pre>
        <button
          onClick={handleCopy}
          style={{
            flexShrink: 0,
            width: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: copied ? 'rgba(104,211,145,0.08)' : t.surface1,
            border: 'none',
            borderLeft: `1px solid ${t.border}`,
            color: copied ? t.success : t.text2,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => { if (!copied) { e.currentTarget.style.background = t.surface2; e.currentTarget.style.color = t.text1; } }}
          onMouseLeave={(e) => { if (!copied) { e.currentTarget.style.background = t.surface1; e.currentTarget.style.color = t.text2; } }}
        >
          {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy</>}
        </button>
      </div>
    </div>
  );
}
