interface SimpleIcon {
  path: string;
  title: string;
}

export function BrandIcon({ icon, size = 16, className }: { icon: SimpleIcon; size?: number; className?: string }) {
  return (
    <svg role="img" aria-label={icon.title} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className}>
      <path d={icon.path} />
    </svg>
  );
}
