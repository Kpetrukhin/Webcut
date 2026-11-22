import React, {useRef, useState} from 'react';
import {ChevronsUpDown} from 'lucide-react';

export interface ScrubNumberFieldProps {
  value: number;
  onChange: (next: number) => void;
  onCommit?: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  sensitivity?: number;
  suffix?: string;
  compact?: boolean;
  accent?: 'cyan' | 'emerald' | 'amber' | 'indigo';
  className?: string;
  ariaLabel?: string;
}

const ACCENT_STYLES = {
  cyan: {
    borderActive: 'border-cyan-400',
    scrubBg: 'border-cyan-400 bg-cyan-500/20 text-cyan-200',
    hoverBorder: 'hover:border-cyan-400/60',
    iconText: 'text-cyan-400',
    compactText: 'text-cyan-300',
  },
  emerald: {
    borderActive: 'border-emerald-400',
    scrubBg: 'border-emerald-400 bg-emerald-500/20 text-emerald-200',
    hoverBorder: 'hover:border-emerald-400/60',
    iconText: 'text-emerald-400',
    compactText: 'text-emerald-300',
  },
  amber: {
    borderActive: 'border-amber-400',
    scrubBg: 'border-amber-400 bg-amber-500/20 text-amber-200',
    hoverBorder: 'hover:border-amber-400/60',
    iconText: 'text-amber-400',
    compactText: 'text-amber-300',
  },
  indigo: {
    borderActive: 'border-indigo-400',
    scrubBg: 'border-indigo-400 bg-indigo-500/20 text-indigo-200',
    hoverBorder: 'hover:border-indigo-400/60',
    iconText: 'text-indigo-400',
    compactText: 'text-indigo-300',
  },
} as const;

export const ScrubNumberField: React.FC<ScrubNumberFieldProps> = ({
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  decimals = 0,
  sensitivity,
  suffix = '',
  compact = false,
  accent = 'cyan',
  className = '',
  ariaLabel,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [scrubbing, setScrubbing] = useState(false);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    startVal: number;
    lastVal: number;
    axis: 'none' | 'x' | 'y';
    moved: boolean;
  } | null>(null);

  const theme = ACCENT_STYLES[accent];
  const effectiveSensitivity =
    sensitivity ?? (step >= 1 ? step * 0.75 : step * 0.5);

  const normalize = (raw: number): number => {
    let v = raw;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (step > 0) {
      v = Math.round(v / step) * step;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
    }
    return Number(v.toFixed(decimals));
  };

  const formatDisplay = (v: number): string => {
    const fixed = Number.isFinite(v) ? v.toFixed(decimals) : '0';
    return suffix ? `${fixed}${suffix}` : fixed;
  };

  const commitDraft = () => {
    const cleaned = draft
      .replace(',', '.')
      .replace(/[^\d.-]/g, '')
      .trim();
    const parsed = Number(cleaned);
    if (cleaned !== '' && cleaned !== '-' && Number.isFinite(parsed)) {
      const next = normalize(parsed);
      onChange(next);
      onCommit?.(next);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type="text"
        inputMode="decimal"
        autoFocus
        aria-label={ariaLabel}
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitDraft();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className={`${
          compact ? 'h-6 w-16 px-1.5 text-[11px]' : 'h-8 w-24 px-2 text-xs'
        } rounded-md border ${theme.borderActive} bg-zinc-900 text-right font-mono text-white focus:outline-none ${className}`}
      />
    );
  }

  return (
    <div
      role="spinbutton"
      aria-label={ariaLabel}
      aria-valuenow={value}
      tabIndex={0}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault();
          const next = normalize(value + step);
          onChange(next);
          onCommit?.(next);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = normalize(value - step);
          onChange(next);
          onCommit?.(next);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setDraft(value.toFixed(decimals));
          setEditing(true);
        }
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startVal: value,
          lastVal: value,
          axis: 'none',
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (!drag) return;
        e.stopPropagation();
        const dx = e.clientX - drag.startX;
        const dy = drag.startY - e.clientY;
        if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
          drag.moved = true;
          drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
          setScrubbing(true);
        }
        if (drag.moved) {
          const delta = drag.axis === 'x' ? dx : dy;
          const next = normalize(drag.startVal + delta * effectiveSensitivity);
          drag.lastVal = next;
          onChange(next);
        }
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        const drag = dragRef.current;
        dragRef.current = null;
        setScrubbing(false);
        if (drag?.moved) {
          onCommit?.(drag.lastVal);
        } else {
          setDraft(value.toFixed(decimals));
          setEditing(true);
        }
      }}
      onPointerCancel={() => {
        const drag = dragRef.current;
        dragRef.current = null;
        setScrubbing(false);
        if (drag?.moved) {
          onCommit?.(drag.lastVal);
        }
      }}
      title="Потяните ↔ / ↕ как в Unity или нажмите для ввода"
      className={`flex cursor-ew-resize touch-none items-center justify-between gap-1 rounded-md border font-mono select-none transition ${
        compact
          ? 'h-6 min-w-[54px] px-1.5 text-[11px]'
          : 'h-8 w-24 rounded-lg px-2 text-xs'
      } ${
        scrubbing
          ? theme.scrubBg
          : `border-white/15 bg-zinc-900/90 ${compact ? theme.compactText : 'text-zinc-100'} ${theme.hoverBorder}`
      } ${className}`}
    >
      <ChevronsUpDown
        className={`${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} shrink-0 ${theme.iconText}`}
      />
      <span className="truncate tabular-nums">{formatDisplay(value)}</span>
    </div>
  );
};
