import React from 'react';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import {
  isScanClassified,
  resolutionShape,
  type ImageResolutionSummary as Summary,
} from '../lib/image-resolution';

// The Images summary, rendered identically in Properties ▸ Advanced and in the
// Compress panel. The rules behind it — what parses, what counts as a spread,
// what counts as a scanned document — live in lib/image-resolution.ts, where
// they have tests; this file only lays them out.

export interface ImageResolutionSummaryProps {
  summary: Summary | null;
  loading: boolean;
  error: string | null;
  /** Prefix for the data-testid attributes, so the two hosts address their own. */
  testIdPrefix: string;
}

export function ImageResolutionSummary({
  summary,
  loading,
  error,
  testIdPrefix,
}: ImageResolutionSummaryProps): React.JSX.Element {
  if (error !== null) {
    return (
      <span className="text-neutral-400" data-testid={`${testIdPrefix}-error`}>
        {tChrome('imageres.failed')}
      </span>
    );
  }
  if (loading || summary === null) {
    return (
      <span className="text-neutral-500" data-testid={`${testIdPrefix}-loading`}>
        {tChrome('imageres.loading')}
      </span>
    );
  }

  const shape = resolutionShape(summary);
  if (shape === 'none') {
    return (
      <span className="text-neutral-400" data-testid={`${testIdPrefix}-none`}>
        {tChrome('imageres.none')}
      </span>
    );
  }

  const images = tChromeCount('imageres.count', summary.images);
  const line =
    shape === 'single'
      ? tChrome('imageres.single', { images, dpi: tNumber(summary.minDpi ?? 0) })
      : tChrome('imageres.range', {
          images,
          min: tNumber(summary.minDpi ?? 0),
          max: tNumber(summary.maxDpi ?? 0),
          median: tNumber(summary.medianDpi ?? 0),
        });

  return (
    <span className="block">
      <span className="block" data-testid={`${testIdPrefix}-dpi`} data-min-dpi={summary.minDpi ?? ''} data-max-dpi={summary.maxDpi ?? ''}>
        {line}
      </span>
      {summary.scanPages > 0 && (
        <span className="block text-neutral-500" data-testid={`${testIdPrefix}-scan`}>
          {tChrome(isScanClassified(summary) ? 'imageres.scanned' : 'imageres.scanPages', {
            scanned: tNumber(summary.scanPages),
            pages: tNumber(summary.pages),
          })}
        </span>
      )}
      {summary.unmeasured > 0 && (
        <span className="block text-neutral-500" data-testid={`${testIdPrefix}-unmeasured`}>
          {tChrome('imageres.unmeasured', { unmeasured: tNumber(summary.unmeasured) })}
        </span>
      )}
    </span>
  );
}
