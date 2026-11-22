import React, {useRef, useState} from 'react';
import {MoveHorizontal} from 'lucide-react';

export interface UnityNumberFieldProps {
  label?: string;
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
  disabled?: boolean;
  haptic?: boolean;
  accent?: 'cyan' | 'emerald' | 'amber' | 'indigo';
  className?: string;
  ariaLabel?: string;
}

const ACCENT_THEME = {
  cyan: {
    borderActive: 'border-cyan-400',
    scrubBg: 'border-cyan-400 bg-cyan-500/20 text-cyan-200',
    hoverBorder: 'hover:border-cyan-400/60',
    iconText: 'text-cyan-400',
    valueText: 'text-cyan-300',
  },
  emerald: {
    borderActive: 'border-emerald-400',
    scrubBg: 'border-emerald-400 bg-emerald-500/20 text-emerald-200',
    hoverBorder: 'hover:border-emerald-400/60',
    iconText: 'text-emerald-400',
    valueText: 'text-emerald-300',
  },
  amber: {
    borderActive: 'border-amber-400',
    scrubBg: 'border-amber-400 bg-amber-500/20 text-amber-200',
    hoverBorder: 'hover:border-amber-400/60',
    iconText: 'text-amber-400',
    valueText: 'text-amber-300',
  },
  indigo: {
    borderActive: 'border-indigo-400',
    scrubBg: 'border-indigo-400 bg-indigo-500/20 text-indigo-200',
    hoverBorder: 'hover:border-indigo-400/60',
    iconText: 'text-indigo-400',
    valueText: 'text-indigo-300',
  },
} as const;

function triggerStepHaptic(enabled: boolean) {
  if (!enabled) return;
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(6);
    }
  } catch {
    // Ignore unsupported / blocked vibration
  }
}

export const UnityNumberField: React.FC<UnityNumberFieldProps> = ({
  label,
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 0.05,
  decimals = 2,
  sensitivity,
  suffix = '',
  compact = false,
  disabled = false,
  haptic = true,
  accent = 'emerald',
  className = '',
  ariaLabel,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [scrubbing, setScrubbing] = useState(false);

  const dragRef = useRef<{
    startX: number;
    startVal: number;
    lastVal: number;
    moved: boolean;
  } | null>(null);

  const theme = ACCENT_THEME[accent];
  // Default sensitivity: 120px horizontal swipe covers ~20 steps smoothly
  const pxPerStep = sensitivity ?? 10;

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
      triggerStepHaptic(haptic);
    }
    setEditing(false);
  };

  const fieldBox = editing ? (
    <input
      type="text"
      inputMode="decimal"
      autoFocus
      disabled={disabled}
      aria-label={ariaLabel || label}
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
        compact ? 'h-7 w-20 px-2 text-xs' : 'h-9 w-28 px-2.5 text-sm'
      } rounded-lg border ${theme.borderActive} bg-zinc-950 text-right font-mono font-semibold text-white focus:outline-none ${className}`}
    />
  ) : (
    <div
      role="spinbutton"
      aria-label={ariaLabel || label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (disabled) return;
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
        if (disabled) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
          startX: e.clientX,
          startVal: value,
          lastVal: value,
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (!drag || disabled) return;
        e.stopPropagation();
        const dx = e.clientX - drag.startX;
        if (!drag.moved && Math.abs(dx) > 4) {
          drag.moved = true;
          setScrubbing(true);
        }
        if (drag.moved) {
          const deltaSteps = dx / pxPerStep;
          const next = normalize(drag.startVal + deltaSteps * step);
          if (next !== drag.lastVal) {
            drag.lastVal = next;
            triggerStepHaptic(haptic);
            onChange(next);
          }
        }
      }}
      onPointerUp={(e) => {
        if (disabled) return;
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
      title="Потяните ↔ влево/вправо или нажмите для ввода числа"
      className={`flex cursor-ew-resize touch-none items-center justify-between gap-1.5 rounded-lg border font-mono font-semibold select-none transition ${
        compact ? 'h-7 min-w-[76px] px-2 text-xs' : 'h-9 min-w-[104px] px-2.5 text-sm'
      } ${
        disabled
          ? 'cursor-not-allowed border-white/10 bg-zinc-900/50 text-zinc-500 opacity-60'
          : scrubbing
            ? theme.scrubBg
            : `border-white/15 bg-zinc-900 ${theme.valueText} ${theme.hoverBorder}`
      } ${className}`}
    >
      <MoveHorizontal
        className={`${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} shrink-0 ${theme.iconText}`}
      />
      <span className="truncate tabular-nums">{formatDisplay(value)}</span>
    </div>
  );

  if (!label) return fieldBox;

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      {fieldBox}
    </div>
  );
};
