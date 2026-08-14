/** Lightweight inline SVG sparkline (no chart dependency). */
export function Sparkline({ points, width = 160, height = 40 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return <span className="muted">no data</span>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${(height - ((p - min) / span) * (height - 4) - 2).toFixed(1)}`)
    .join(' ');
  const up = points[points.length - 1]! >= points[0]!;
  return (
    <svg width={width} height={height} className="sparkline" role="img" aria-label="price sparkline">
      <path d={d} fill="none" stroke={up ? '#3fb68b' : '#e05d5d'} strokeWidth="1.5" />
    </svg>
  );
}
