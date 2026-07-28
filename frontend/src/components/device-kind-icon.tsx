import { Sprout } from 'lucide-react';
import { siXiaomi } from 'simple-icons';
import type { DeviceKind } from '@/lib/types';
import { BrandIcon } from './brand-icon';

export function DeviceKindIcon({ kind, size = 16, className }: { kind: DeviceKind; size?: number; className?: string }) {
  if (kind === 'XIAOMI_LYWSD03MMC') {
    return <BrandIcon icon={siXiaomi} size={size} className={className} />;
  }

  // simple-icons n'a pas de logo pour Parrot (le fabricant du Parrot Pot) — seul "Parrot Security"
  // y figure, sans rapport. Fallback lucide plutôt qu'une icône de marque erronée.
  return <Sprout size={size} className={className} />;
}
