// A 5-dot categorical gauge for PlantProfile.sunCategory/waterCategory/fertilizerCategory — these
// are Parrot's own real categorical ratings (1-4 or 1-3 observed in real data), not a formula this
// project invented. Deliberately not a reuse of SensorGauge (a circular gauge for a continuous
// min/max range) — a different visual language for a different kind of value. See
// docs/superpowers/specs/2026-08-31-plant-database-page-design.md, "Jauges de besoins".
const TOTAL_DOTS = 5;

export function NeedsGauge({ label, value, rangeLabel }: { label: string; value: number; rangeLabel?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {rangeLabel && <span className="text-xs text-muted-foreground">{rangeLabel}</span>}
        <div className="flex gap-1">
          {Array.from({ length: TOTAL_DOTS }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length (TOTAL_DOTS), never reordered/filtered — the index is a stable identity here
            <span key={index} className={index < value ? 'h-2.5 w-2.5 rounded-full bg-primary' : 'h-2.5 w-2.5 rounded-full bg-muted'} />
          ))}
        </div>
      </div>
    </div>
  );
}
