import { Sprout } from 'lucide-react';
import { siXiaomi } from 'simple-icons';
import type { DeviceKind } from '@/lib/types';
import { BrandIcon } from './brand-icon';

export function DeviceKindIcon({ kind, size = 16, className }: { kind: DeviceKind; size?: number; className?: string }) {
  if (kind === 'XIAOMI_LYWSD03MMC') {
    return <BrandIcon icon={siXiaomi} size={size} className={className} />;
  }

  // simple-icons has no logo for Parrot (the Parrot Pot manufacturer) — only "Parrot Security"
  // is listed there, unrelated. Fallback to lucide rather than an incorrect brand icon.
  return <Sprout size={size} className={className} />;
}
