import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';

export interface HistoryPoint {
  timestamp: string;
  value: number;
}

export function HistoryChart({ data, label, unit }: { data: HistoryPoint[]; label: string; unit?: string }) {
  const config = {
    value: { label: `${label}${unit ? ` (${unit})` : ''}`, color: 'var(--color-teal-500)' },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={config} className="aspect-auto h-40 w-full">
      <AreaChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="history-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="timestamp"
          tickLine={false}
          axisLine={false}
          tickFormatter={(value: string) =>
            new Date(value).toLocaleString(undefined, { day: '2-digit', hour: '2-digit', minute: '2-digit' })
          }
          minTickGap={40}
        />
        <YAxis tickLine={false} axisLine={false} width={32} />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(value) => new Date(value as string).toLocaleString()} indicator="line" />}
        />
        <Area dataKey="value" type="monotone" fill="url(#history-fill)" stroke="var(--color-value)" strokeWidth={2} />
      </AreaChart>
    </ChartContainer>
  );
}
