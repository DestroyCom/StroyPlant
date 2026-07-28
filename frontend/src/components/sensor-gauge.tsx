import type { ReactNode } from 'react';

const TONE_VARS = {
  primary: 'var(--color-teal-500)',
  accent: 'var(--color-spring-500)',
  info: 'var(--color-blue-500)',
  danger: 'var(--destructive)',
  warning: 'var(--warning-foreground)',
} as const;

export function SensorGauge({
  label,
  value,
  max = 100,
  unit = '%',
  tone = 'primary',
  icon,
  hint,
}: {
  label: string;
  value: number;
  max?: number;
  unit?: string;
  tone?: keyof typeof TONE_VARS;
  icon?: ReactNode;
  hint?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = TONE_VARS[tone] ?? TONE_VARS.primary;

  return (
    <div className="flex w-28 flex-col items-center gap-2">
      <div
        className="flex h-21 w-21 items-center justify-center rounded-full"
        style={{ background: `conic-gradient(${color} ${pct * 3.6}deg, var(--muted) 0deg)` }}
      >
        <div className="flex h-17 w-17 flex-col items-center justify-center gap-0.5 rounded-full bg-card">
          {icon}
          <span className="text-sm font-bold text-foreground">
            {Math.round(value)}
            {unit}
          </span>
        </div>
      </div>
      <span className="text-center text-xs text-muted-foreground">{label}</span>
      {hint && <span className="text-center text-[11px] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}
