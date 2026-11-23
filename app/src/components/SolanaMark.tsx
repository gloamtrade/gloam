import { useId } from "react";

/**
 * Solana's logo mark: the three bars in Solana's own gradient (#9945FF to
 * #19FB9B, from the Solana brand kit). Decorative: it sits next to the word
 * Solana, so it has no name of its own.
 */
export function SolanaMark({ size = 16, className }: { size?: number; className?: string }) {
  const id = `sol-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="17 20 46 40" fill="none" aria-hidden className={className}>
      <path
        fill={`url(#${id})`}
        d="m62.62 51.54-7.54 7.91a1.75 1.75 0 0 1-1.29.55H18.02a.9.9 0 0 1-.8-.52.84.84 0 0 1 .16-.92l7.55-7.92a1.75 1.75 0 0 1 1.28-.55h35.77a.87.87 0 0 1 .8.52.84.84 0 0 1-.16.93Zm-7.54-15.95a1.75 1.75 0 0 0-1.29-.54H18.02a.89.89 0 0 0-.8.51.84.84 0 0 0 .16.93l7.55 7.92a1.75 1.75 0 0 0 1.28.54h35.77a.89.89 0 0 0 .8-.51.84.84 0 0 0-.16-.93l-7.54-7.92ZM18.02 29.9h35.77a1.79 1.79 0 0 0 1.29-.54l7.54-7.92a.85.85 0 0 0 .16-.93.87.87 0 0 0-.8-.51H26.21a1.79 1.79 0 0 0-1.28.54l-7.55 7.92a.85.85 0 0 0-.16.93.89.89 0 0 0 .8.52Z"
      />
      <defs>
        <linearGradient id={id} x1="21.05" y1="60.95" x2="57.38" y2="18.63" gradientUnits="userSpaceOnUse">
          <stop offset=".08" stopColor="#9945FF" />
          <stop offset=".3" stopColor="#8752F3" />
          <stop offset=".5" stopColor="#5497D5" />
          <stop offset=".6" stopColor="#43B4CA" />
          <stop offset=".72" stopColor="#28E0B9" />
          <stop offset=".97" stopColor="#19FB9B" />
        </linearGradient>
      </defs>
    </svg>
  );
}
