import React from 'react';
import { rangeFillPercent } from '../lib/range-fill';

type RangeInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * A range input whose track is drawn by the stylesheet. The filled share is
 * handed to it as `--range-fill`: a self-drawn track has no native filled
 * part, so a controlled value that changes without an input event (a preset
 * that sets the slider) must still repaint the fill.
 */
export const RangeInput = React.forwardRef<HTMLInputElement, RangeInputProps>(function RangeInput(
  { style, ...props },
  ref,
) {
  const fill = rangeFillPercent(props.value ?? props.defaultValue, props.min, props.max);
  return (
    <input
      ref={ref}
      type="range"
      {...props}
      style={{ ...style, ['--range-fill' as string]: fill } as React.CSSProperties}
    />
  );
});
