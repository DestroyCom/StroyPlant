import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TONE_CLASSES = {
  primary: 'text-teal-700',
  info: 'text-blue-700',
  danger: 'text-destructive',
  accent: 'text-spring-700',
} as const;

export function StatChip({
  icon,
  value,
  label,
  tone = 'primary',
}: {
  icon: ReactNode;
  value: string;
  label: string;
  tone?: keyof typeof TONE_CLASSES;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={cn('inline-flex', TONE_CLASSES[tone] ?? TONE_CLASSES.primary)}>{icon}</span>
      <div className="flex flex-col leading-tight">
        <span className="text-base font-bold text-foreground">{value}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}
