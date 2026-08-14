import { describeGauge } from '../lib/format';
import type { MetricSample } from '../types';

/**
 * Large visual resource-metric card (issue #9): big percentage readout,
 * progress meter with ARIA attributes, used/total/available numbers,
 * explicit scope label, and a text status pill so state is never
 * conveyed by color alone. Unavailable metrics render an indeterminate
 * (empty) meter — never a fake 0% bar.
 */
export function MetricCard({ label, metric }: { label: string; metric: MetricSample }) {
  const g = describeGauge(metric);
  const ariaValueText =
    g.ariaValueNow === null
      ? `${g.statusLabel}`
      : `${g.percentText} used${g.level === 'normal' ? '' : ` (${g.statusLabel.toLowerCase()})`}`;
  return (
    <div className={`metric-card metric-card-${g.meterTone}`}>
      <div className="metric-head">
        <span className="metric-label">{label}</span>
        <span className={`status-pill status-${g.level}`}>{g.statusLabel}</span>
      </div>
      <div className="metric-scope muted small">{g.scope}</div>
      <div className="metric-percent" aria-hidden="true">
        {g.percentText}
        <span className="metric-percent-caption muted"> used</span>
      </div>
      {g.fillRatio === null ? (
        <div className="meter meter-indeterminate" aria-hidden="true">
          <div className="meter-fill meter-fill-muted" />
        </div>
      ) : (
        <div
          className="meter"
          role="progressbar"
          aria-label={`${label} (${g.scope})`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={g.ariaValueNow ?? 0}
          aria-valuetext={ariaValueText}
        >
          <div className={`meter-fill meter-fill-${g.meterTone}`} style={{ width: `${g.fillRatio * 100}%` }} />
        </div>
      )}
      <div className="metric-numbers small">
        <span>
          <strong>{g.usedText}</strong> used
        </span>
        {g.totalText !== null && <span> of {g.totalText}</span>}
        {g.availableText !== null && <span> · {g.availableText} free</span>}
      </div>
      {g.reason && <div className="metric-reason small">{g.reason}</div>}
    </div>
  );
}
