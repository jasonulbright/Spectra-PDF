interface DashedBorderProps {
  width: number;
  height: number;
  radius: number;
  dash?: string;
}

export function DashedBorder({
  width,
  height,
  radius,
  dash = '5 10',
}: DashedBorderProps): React.JSX.Element {
  return (
    <svg className="dashed-border" width={width} height={height} aria-hidden="true">
      <rect
        x="0.75"
        y="0.75"
        width={Math.max(0, width - 1.5)}
        height={Math.max(0, height - 1.5)}
        rx={radius}
        ry={radius}
        fill="none"
        strokeWidth="1.5"
        strokeDasharray={dash}
      />
    </svg>
  );
}
