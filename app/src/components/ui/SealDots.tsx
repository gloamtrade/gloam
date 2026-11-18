/** A sealed amount: a short row of dots in place of a number. */
export function SealDots({
  n = 6,
  className = "",
  label = "Amount hidden",
  dot,
}: {
  n?: number;
  className?: string;
  label?: string;
  /** Dot size in px, for big figures (the gap follows it). Default 6. */
  dot?: number;
}) {
  return (
    <span className={`seal-dots ${className}`} role="img" aria-label={label} style={dot ? { gap: Math.round(dot * 0.7) } : undefined}>
      {Array.from({ length: n }).map((_, i) => (
        <i key={i} style={dot ? { width: dot, height: dot } : undefined} />
      ))}
    </span>
  );
}
