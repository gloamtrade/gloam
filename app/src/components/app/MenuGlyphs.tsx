/**
 * The account menu's marks, shared by the EVM menu (WalletMenu) and Solana's
 * (SolanaWalletMenu) so both draw the same rows: 16px strokes in currentColor.
 */
const glyph = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  "aria-hidden": true,
} as const;

export function GridGlyph() {
  return (
    <svg {...glyph}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function SendGlyph() {
  return (
    <svg {...glyph}>
      <path d="M5 12h13M13 6.5 18.5 12 13 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GearGlyph() {
  return (
    <svg {...glyph}>
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3.75v2M12 18.25v2M20.25 12h-2M5.75 12h-2M17.83 6.17l-1.41 1.41M7.58 16.42l-1.41 1.41M17.83 17.83l-1.41-1.41M7.58 7.58L6.17 6.17"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ExitGlyph() {
  return (
    <svg {...glyph}>
      <path d="M14 5.5H7A1.5 1.5 0 0 0 5.5 7v10A1.5 1.5 0 0 0 7 18.5h7M11 12h9M17 9l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
