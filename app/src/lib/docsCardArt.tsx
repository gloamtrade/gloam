import type { CSSProperties, ReactNode } from "react";
import { C } from "./docsCard";
import { MAINNET_CHAINS, mainnetChainPool } from "./mainnet";

/**
 * The small drawings on the docs link cards, one per page, each built from a
 * few plain shapes. Monochrome, with the green tint only where something is
 * private. They render inside next/og, so every box with children is a flex box.
 */

const row: CSSProperties = { display: "flex", alignItems: "center" };
const col: CSSProperties = { display: "flex", flexDirection: "column" };

function Text({ children, size = 22, color = C.paper, weight = 300, style }: {
  children: ReactNode;
  size?: number;
  color?: string;
  weight?: 300 | 500;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", fontSize: size, color, fontWeight: weight, letterSpacing: "-0.01em", ...style }}>
      {children}
    </div>
  );
}

function Bar({ w, h = 12, color = C.raised }: { w: number; h?: number; color?: string }) {
  return <div style={{ display: "flex", width: w, height: h, borderRadius: h / 2, background: color }} />;
}

/** A row of small dots standing in for a hidden amount. */
function Hidden({ n = 4, color = C.tint, gap = 7, d = 9 }: { n?: number; color?: string; gap?: number; d?: number }) {
  return (
    <div style={{ ...row, gap }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={{ display: "flex", width: d, height: d, borderRadius: d / 2, background: color }} />
      ))}
    </div>
  );
}

function Check({ size = 18, color = C.paper, width = 2.4 }: { size?: number; color?: string; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke={color} strokeWidth={width * (24 / size)} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The Gloam mark at any size: a paper square with the ink corner cut in. */
function MiniMark({ s = 28 }: { s?: number }) {
  return (
    <div style={{ position: "relative", display: "flex", width: s, height: s, borderRadius: s * 0.27, background: C.paper }}>
      <div
        style={{
          position: "absolute",
          display: "flex",
          left: s * 0.468,
          top: s * 0.125,
          width: s * 0.375,
          height: s * 0.375,
          borderRadius: s * 0.114,
          background: C.ink,
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- pages */

/** Docs overview: an index of four sections. */
export function IndexArt() {
  const tile = (label: string, first = false) => (
    <div
      style={{
        ...col,
        justifyContent: "space-between",
        width: 150,
        height: 104,
        padding: "16px 18px",
        borderRadius: 16,
        border: `1.5px solid ${first ? C.tintLine : C.line}`,
        background: first ? C.tintSoft : C.surface,
      }}
    >
      <Bar w={first ? 34 : 26} h={6} color={first ? C.tint : C.line} />
      <Text size={24} color={first ? C.paper : C.mute}>{label}</Text>
    </div>
  );
  return (
    <div style={{ ...col, gap: 14 }}>
      <div style={{ ...row, gap: 14 }}>
        {tile("Shield", true)}
        {tile("Pay")}
      </div>
      <div style={{ ...row, gap: 14 }}>
        {tile("Payroll")}
        {tile("Prove")}
      </div>
    </div>
  );
}

/** Agents: a request to an agent and its reply. */
export function ChatArt() {
  return (
    <div style={{ ...col, width: 320, gap: 16 }}>
      <div
        style={{
          ...row,
          alignSelf: "flex-end",
          padding: "16px 22px",
          borderRadius: "22px 22px 6px 22px",
          border: `1.5px solid ${C.line}`,
          background: C.surface,
        }}
      >
        <Text size={24}>Pay Robin 25 USDG</Text>
      </div>
      <div
        style={{
          ...row,
          alignSelf: "flex-start",
          gap: 10,
          padding: "16px 22px",
          borderRadius: "22px 22px 22px 6px",
          border: `1.5px solid ${C.tintLine}`,
          background: C.tintSoft,
        }}
      >
        <Check size={20} color={C.tint} />
        <Text size={24} color={C.tint}>Sent, amount hidden</Text>
      </div>
    </div>
  );
}

/** The short label and monogram each mainnet gets on a card. */
const CHAIN_PILLS: Record<string, [label: string, mono: string]> = {
  "Robinhood Chain": ["Robinhood", "RH"],
  Tempo: ["Tempo", "T"],
  Base: ["Base", "B"],
  Ethereum: ["Ethereum", "E"],
  Elysium: ["Elysium", "EL"],
};

/** The mainnets with a pool in, as card pills (lib/mainnet.ts). */
function liveChainPills(): [string, string][] {
  return MAINNET_CHAINS.filter((c) => mainnetChainPool(c.chainId)).map((c) => CHAIN_PILLS[c.name] ?? [c.name, c.name.slice(0, 1)]);
}

/**
 * Networks: the chains feeding one private pool. Every live mainnet by
 * default; a dated card (a launch post) passes the chains it was about.
 */
export function ChainsArt({ chains = liveChainPills() }: { chains?: [label: string, mono: string][] } = {}) {
  const n = Math.max(chains.length, 1);
  const tall = n <= 2;
  const h = tall ? 58 : 40;
  const gap = tall ? 60 : (200 - n * h) / (n - 1 || 1);
  const tops = chains.map((_, i) => (tall ? (n === 1 ? 71 : 12 + i * (h + gap)) : i * (h + gap)));
  const chain = (label: string, mono: string) => (
    <div
      style={{
        ...row,
        gap: tall ? 12 : 10,
        width: 214,
        height: h,
        padding: tall ? "0 16px 0 10px" : "0 14px 0 6px",
        borderRadius: h / 2,
        border: `1.5px solid ${C.line}`,
        background: C.surface,
      }}
    >
      <div
        style={{
          ...row,
          justifyContent: "center",
          width: tall ? 38 : 28,
          height: tall ? 38 : 28,
          borderRadius: tall ? 19 : 14,
          background: C.raised,
          fontSize: tall ? 17 : 13,
          fontWeight: 500,
          color: C.paper,
        }}
      >
        {mono}
      </div>
      <Text size={tall ? 22 : 18}>{label}</Text>
    </div>
  );
  return (
    <div style={{ position: "relative", display: "flex", width: 330, height: 200 }}>
      <svg width={330} height={200} viewBox="0 0 330 200" style={{ position: "absolute", left: 0, top: 0 }}>
        {tops.map((top, i) => {
          const y = top + h / 2;
          return <path key={i} d={`M214 ${y} C 250 ${y}, 250 100, 268 100`} fill="none" stroke={C.line} strokeWidth={2} />;
        })}
      </svg>
      {chains.map(([label, mono], i) => (
        <div key={label} style={{ position: "absolute", left: 0, top: tops[i], display: "flex" }}>
          {chain(label, mono)}
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: 268,
          top: 69,
          ...row,
          justifyContent: "center",
          width: 62,
          height: 62,
          borderRadius: 18,
          border: `1.5px solid ${C.tintLine}`,
          background: C.tintSoft,
        }}
      >
        <MiniMark s={30} />
      </div>
    </div>
  );
}

/** Compare: two columns side by side. */
export function CompareArt() {
  const column = (label: string, ours: boolean, widths: number[]) => (
    <div
      style={{
        ...col,
        gap: 20,
        width: 152,
        padding: "20px 20px 24px",
        borderRadius: 18,
        border: `1.5px solid ${ours ? C.tintLine : C.line}`,
        background: ours ? C.tintSoft : C.surface,
      }}
    >
      <Text size={22} color={ours ? C.tint : C.mute} weight={500}>{label}</Text>
      {widths.map((w, i) => (
        <Bar key={i} w={w} h={10} color={ours ? "rgba(143, 211, 173, 0.35)" : C.raised} />
      ))}
    </div>
  );
  return (
    <div style={{ ...row, gap: 16, alignItems: "flex-start" }}>
      {column("Gloam", true, [96, 72, 104, 64])}
      {column("Others", false, [84, 104, 60, 92])}
    </div>
  );
}

/** Prices and data: a price line. */
export function ChartArt() {
  const pts: [number, number][] = [
    [0, 118], [26, 104], [52, 112], [78, 86], [104, 94], [130, 70], [156, 78],
    [182, 56], [208, 66], [234, 44], [260, 52], [286, 30], [312, 38],
  ];
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x + 4} ${y}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={324} height={170} viewBox="0 0 324 170">
      <path d="M4 150 H320" stroke={C.line} strokeWidth={1.5} strokeDasharray="4 7" />
      <path d="M4 95 H320" stroke={C.raised} strokeWidth={1.5} strokeDasharray="4 7" />
      <path d={d} fill="none" stroke={C.paper} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx + 4} cy={ly} r={7} fill={C.ink} stroke={C.paper} strokeWidth={3} />
    </svg>
  );
}

/** How shield works: a closed padlock. */
export function LockArt() {
  return (
    <svg width={170} height={210} viewBox="0 0 170 210">
      <path d="M40 92 V64 a45 45 0 0 1 90 0 V92" fill="none" stroke={C.paper} strokeWidth={10} strokeLinecap="round" />
      <rect x={14} y={88} width={142} height={110} rx={26} fill={C.tintSoft} stroke={C.tintLine} strokeWidth={3} />
      <circle cx={85} cy={134} r={13} fill={C.tint} />
      <rect x={80} y={138} width={10} height={30} rx={5} fill={C.tint} />
    </svg>
  );
}

/** Partner API: a key and a masked API key. */
export function KeyArt() {
  return (
    <div style={{ ...col, alignItems: "center", gap: 26 }}>
      <svg width={150} height={84} viewBox="0 0 150 84">
        <circle cx={40} cy={42} r={30} fill="none" stroke={C.paper} strokeWidth={8} />
        <circle cx={40} cy={42} r={9} fill={C.paper} />
        <path d="M70 42 H140 M118 42 V64 M136 42 V58" fill="none" stroke={C.paper} strokeWidth={8} strokeLinecap="round" />
      </svg>
      <div
        style={{
          ...row,
          gap: 10,
          height: 54,
          padding: "0 22px",
          borderRadius: 27,
          border: `1.5px solid ${C.line}`,
          background: C.surface,
        }}
      >
        <Text size={22} color={C.mute}>gloam_live_</Text>
        <Hidden n={6} d={8} gap={6} color={C.tint} />
      </div>
    </div>
  );
}

/** Payroll: a team list, amounts hidden. */
export function PayrollArt() {
  const names = [118, 92, 136, 104];
  return (
    <div
      style={{
        ...col,
        width: 320,
        padding: "8px 22px",
        borderRadius: 20,
        border: `1.5px solid ${C.line}`,
        background: C.surface,
      }}
    >
      {names.map((w, i) => (
        <div
          key={i}
          style={{
            ...row,
            justifyContent: "space-between",
            height: 58,
            borderTop: i ? `1px solid ${C.raised}` : "none",
          }}
        >
          <div style={{ ...row, gap: 14 }}>
            <div style={{ display: "flex", width: 32, height: 32, borderRadius: 16, background: C.raised }} />
            <Bar w={w} h={10} color={C.line} />
          </div>
          <Hidden n={4} d={8} gap={6} />
        </div>
      ))}
    </div>
  );
}

/** What stays private: a deposit and a cash out, the link between them hidden. */
export function UnlinkArt() {
  const node = (label: string) => (
    <div style={{ ...col, alignItems: "center", gap: 16, width: 100 }}>
      <div
        style={{
          display: "flex",
          width: 60,
          height: 60,
          borderRadius: 30,
          border: `2px solid ${C.paper}`,
          background: C.surface,
        }}
      />
      <Text size={21} color={C.mute} style={{ whiteSpace: "nowrap" }}>{label}</Text>
    </div>
  );
  return (
    <div style={{ position: "relative", display: "flex", width: 330, height: 110 }}>
      <svg width={330} height={110} viewBox="0 0 330 110" style={{ position: "absolute", left: 0, top: 0 }}>
        <path d="M86 30 H138 M192 30 H244" stroke={C.faint} strokeWidth={2.5} strokeDasharray="2 9" strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", left: 0, top: 0, display: "flex" }}>{node("Deposit")}</div>
      <div style={{ position: "absolute", left: 230, top: 0, display: "flex" }}>{node("Cash out")}</div>
      <div
        style={{
          position: "absolute",
          left: 141,
          top: 6,
          ...row,
          justifyContent: "center",
          width: 48,
          height: 48,
          borderRadius: 24,
          border: `1.5px solid ${C.tintLine}`,
          background: C.tintSoft,
        }}
      >
        <svg width={22} height={24} viewBox="0 0 22 24">
          <path d="M6 11 V7.5 a5 5 0 0 1 10 0 V11" fill="none" stroke={C.tint} strokeWidth={2.4} strokeLinecap="round" />
          <rect x={3} y={10.5} width={16} height={12} rx={3.5} fill={C.tint} />
        </svg>
      </div>
    </div>
  );
}

/** Private pay: a send with the private switch on. */
export function SendArt() {
  return (
    <div
      style={{
        ...col,
        gap: 22,
        width: 300,
        padding: "24px 24px",
        borderRadius: 22,
        border: `1.5px solid ${C.line}`,
        background: C.surface,
      }}
    >
      <div style={{ ...row, justifyContent: "space-between" }}>
        <Text size={24}>Private</Text>
        <div
          style={{
            ...row,
            justifyContent: "flex-end",
            width: 70,
            height: 40,
            padding: 4,
            borderRadius: 20,
            border: `1.5px solid ${C.tintLine}`,
            background: C.tintSoft,
          }}
        >
          <div style={{ display: "flex", width: 30, height: 30, borderRadius: 15, background: C.tint }} />
        </div>
      </div>
      <div
        style={{
          ...row,
          justifyContent: "center",
          height: 54,
          borderRadius: 27,
          background: C.paper,
        }}
      >
        <Text size={22} color={C.ink} weight={500}>Send</Text>
      </div>
    </div>
  );
}

/** Private swaps: one token for another. */
export function SwapArt() {
  const chip = (symbol: string, glyph: ReactNode) => (
    <div
      style={{
        ...row,
        gap: 14,
        width: 240,
        height: 70,
        padding: "0 20px 0 14px",
        borderRadius: 35,
        border: `1.5px solid ${C.line}`,
        background: C.surface,
      }}
    >
      {glyph}
      <Text size={26}>{symbol}</Text>
    </div>
  );
  const usdg = (
    <div
      style={{
        ...row,
        justifyContent: "center",
        width: 42,
        height: 42,
        borderRadius: 21,
        background: C.raised,
        fontSize: 22,
        color: C.paper,
      }}
    >
      $
    </div>
  );
  return (
    <div style={{ ...col, alignItems: "center" }}>
      {chip("USDG", usdg)}
      <div
        style={{
          ...row,
          justifyContent: "center",
          width: 48,
          height: 48,
          margin: "-8px 0",
          borderRadius: 24,
          border: `1.5px solid ${C.tintLine}`,
          background: C.ink,
        }}
      >
        <svg width={22} height={22} viewBox="0 0 24 24">
          <path d="M8 4v15M8 19l-4-4M8 19l4-4M16 20V5M16 5l-4 4M16 5l4 4" fill="none" stroke={C.tint} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {chip("GLOAM", <MiniMark s={40} />)}
    </div>
  );
}

/** What ships when: live, next, later. */
export function TimelineArt() {
  const stop = (label: string, state: "live" | "next" | "later") => (
    <div style={{ ...col, alignItems: "center", gap: 16, width: 90 }}>
      <div
        style={{
          display: "flex",
          width: 26,
          height: 26,
          borderRadius: 13,
          background: state === "live" ? C.tint : C.ink,
          border: state === "live" ? "none" : `2.5px solid ${state === "next" ? C.paper : C.line}`,
        }}
      />
      <Text size={22} color={state === "later" ? C.faint : state === "live" ? C.tint : C.paper}>{label}</Text>
    </div>
  );
  return (
    <div style={{ position: "relative", display: "flex", width: 320, height: 80 }}>
      <div style={{ position: "absolute", left: 45, top: 12, width: 115, height: 2, background: C.mute, display: "flex" }} />
      <div style={{ position: "absolute", left: 160, top: 12, width: 115, height: 2, background: C.line, display: "flex" }} />
      <div style={{ position: "absolute", left: 0, top: 0, ...row, alignItems: "flex-start", gap: 25 }}>
        {stop("Live", "live")}
        {stop("Next", "next")}
        {stop("Later", "later")}
      </div>
    </div>
  );
}

/** Production gate: the checklist, with the multisig owner still open. */
export function ChecklistArt() {
  const items: [string, boolean][] = [
    ["Final keys", true],
    ["Deposit limits", true],
    ["Internal review", true],
    ["Multisig owner", false],
  ];
  return (
    <div style={{ ...col, gap: 18, width: 290 }}>
      {items.map(([label, done]) => (
        <div key={label} style={{ ...row, gap: 16 }}>
          <div
            style={{
              ...row,
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: 9,
              border: `2px solid ${done ? C.paper : C.line}`,
              background: done ? C.paper : C.ink,
            }}
          >
            {done ? <Check size={20} color={C.ink} width={2.6} /> : null}
          </div>
          <Text size={24} color={done ? C.paper : C.faint}>{label}</Text>
        </div>
      ))}
    </div>
  );
}

/** Proofs: a seal with a check. */
export function SealArt() {
  const n = 16;
  const pts = Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? 84 : 96;
    const a = (Math.PI * i) / n - Math.PI / 2;
    return `${(100 + r * Math.cos(a)).toFixed(1)} ${(100 + r * Math.sin(a)).toFixed(1)}`;
  });
  return (
    <svg width={200} height={200} viewBox="0 0 200 200">
      <path d={`M${pts.join(" L")} Z`} fill={C.tintSoft} stroke={C.tintLine} strokeWidth={2.5} strokeLinejoin="round" />
      <circle cx={100} cy={100} r={64} fill="none" stroke={C.tintLine} strokeWidth={1.5} />
      <path d="M72 102 L92 122 L130 82" fill="none" stroke={C.tint} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Quickstart: ten minutes on the clock. */
export function TimerArt() {
  const r = 86;
  const len = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", display: "flex", width: 200, height: 200 }}>
      <svg width={200} height={200} viewBox="0 0 200 200" style={{ position: "absolute", left: 0, top: 0 }}>
        <circle cx={100} cy={100} r={r} fill="none" stroke={C.raised} strokeWidth={10} />
        <circle
          cx={100}
          cy={100}
          r={r}
          fill="none"
          stroke={C.paper}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${len / 6} ${len}`}
          transform="rotate(-90 100 100)"
        />
      </svg>
      <div style={{ ...col, alignItems: "center", justifyContent: "center", width: 200, height: 200 }}>
        <Text size={64} style={{ lineHeight: 1, letterSpacing: "-0.03em" }}>10</Text>
        <Text size={22} color={C.mute} style={{ marginTop: 4 }}>minutes</Text>
      </div>
    </div>
  );
}

/** SDK: the install line. */
export function CodeArt() {
  const nowrap: CSSProperties = { whiteSpace: "nowrap", flexShrink: 0 };
  return (
    <div
      style={{
        ...row,
        gap: 12,
        height: 72,
        padding: "0 22px",
        borderRadius: 16,
        border: `1.5px solid ${C.line}`,
        background: C.surface,
      }}
    >
      <Text size={22} color={C.faint} style={nowrap}>$</Text>
      <Text size={22} color={C.mute} style={nowrap}>npm i</Text>
      <Text size={22} style={nowrap}>@gloamtrade/sdk</Text>
      <div style={{ display: "flex", flexShrink: 0, width: 11, height: 26, borderRadius: 2, background: C.tint }} />
    </div>
  );
}

/** Selective disclosure: one note, amount and asset shown, the rest kept back. */
export function RevealArt() {
  const field = (label: string, value: ReactNode) => (
    <div style={{ ...row, justifyContent: "space-between", height: 50 }}>
      <Text size={22} color={C.faint}>{label}</Text>
      {value}
    </div>
  );
  return (
    <div
      style={{
        ...col,
        width: 300,
        padding: "12px 24px",
        borderRadius: 20,
        border: `1.5px solid ${C.line}`,
        background: C.surface,
      }}
    >
      {field("Amount", <Text size={24}>250</Text>)}
      {field("Asset", <Text size={24}>USDG</Text>)}
      {field("Owner", <Bar w={96} h={14} color={C.tintSoft} />)}
      {field("History", <Bar w={120} h={14} color={C.tintSoft} />)}
    </div>
  );
}

/** API reference: the exports, one import. */
export function ExportsArt() {
  const names = ["buildShieldBoundIntent", "buildPrivateSendIntent", "syncTree", "mainnetNetwork"];
  return (
    <div style={{ ...row, gap: 18 }}>
      <svg width={28} height={180} viewBox="0 0 28 180">
        <path
          d="M25 3 C13 3 12 9 12 22 V74 C12 84 9 90 3 90 C9 90 12 96 12 106 V158 C12 171 13 177 25 177"
          fill="none"
          stroke={C.faint}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </svg>
      <div style={{ ...col, gap: 16 }}>
        {names.map((n, i) => (
          <Text key={n} size={22} color={i === 0 ? C.paper : C.mute} style={{ whiteSpace: "nowrap" }}>{n}</Text>
        ))}
      </div>
    </div>
  );
}

/** Sealed trade, retired: a sealed envelope, set aside. */
export function RetiredArt() {
  return (
    <div style={{ ...col, alignItems: "center", gap: 22 }}>
      <svg width={210} height={140} viewBox="0 0 210 140" style={{ opacity: 0.55 }}>
        <rect x={4} y={4} width={202} height={132} rx={16} fill={C.surface} stroke={C.mute} strokeWidth={3} />
        <path d="M8 12 L105 82 L202 12" fill="none" stroke={C.mute} strokeWidth={3} strokeLinejoin="round" />
        <circle cx={105} cy={82} r={20} fill={C.raised} stroke={C.mute} strokeWidth={3} />
      </svg>
      <div
        style={{
          ...row,
          height: 40,
          padding: "0 18px",
          borderRadius: 20,
          border: `1.5px solid ${C.line}`,
        }}
      >
        <Text size={20} color={C.mute}>Retired</Text>
      </div>
    </div>
  );
}

/** Testnet: a drop from the faucet. */
export function DropArt() {
  return (
    <div style={{ ...col, alignItems: "center", gap: 20 }}>
      <svg width={130} height={170} viewBox="0 0 130 170">
        <path
          d="M65 6 C 65 6, 8 72, 8 106 a57 57 0 0 0 114 0 C 122 72, 65 6, 65 6 Z"
          fill={C.surface}
          stroke={C.paper}
          strokeWidth={4}
          strokeLinejoin="round"
        />
        <path d="M36 110 a30 30 0 0 0 22 30" fill="none" stroke={C.mute} strokeWidth={4} strokeLinecap="round" />
      </svg>
      <Text size={22} color={C.mute}>Free test funds</Text>
    </div>
  );
}

/** Threat model: a shield. */
export function ShieldArt() {
  return (
    <svg width={180} height={214} viewBox="0 0 180 214">
      <path
        d="M90 6 L170 36 V100 C170 152 136 188 90 208 C44 188 10 152 10 100 V36 Z"
        fill={C.surface}
        stroke={C.paper}
        strokeWidth={4}
        strokeLinejoin="round"
      />
      <path
        d="M90 34 L144 54 V102 C144 138 122 164 90 179 C58 164 36 138 36 102 V54 Z"
        fill={C.tintSoft}
        stroke={C.tintLine}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Whitepaper: a page with its corner folded. */
export function PaperArt() {
  return (
    <svg width={200} height={250} viewBox="0 0 200 250">
      <path d="M8 18 a12 12 0 0 1 12 -12 H146 L192 52 V230 a12 12 0 0 1 -12 12 H20 a12 12 0 0 1 -12 -12 Z" fill={C.surface} stroke={C.paper} strokeWidth={3} strokeLinejoin="round" />
      <path d="M146 6 V40 a12 12 0 0 0 12 12 H192" fill="none" stroke={C.paper} strokeWidth={3} strokeLinejoin="round" />
      <rect x={34} y={44} width={84} height={12} rx={6} fill={C.paper} />
      <rect x={34} y={88} width={130} height={8} rx={4} fill={C.line} />
      <rect x={34} y={110} width={118} height={8} rx={4} fill={C.line} />
      <rect x={34} y={132} width={130} height={8} rx={4} fill={C.line} />
      <rect x={34} y={154} width={92} height={8} rx={4} fill={C.line} />
      <rect x={34} y={190} width={110} height={8} rx={4} fill={C.raised} />
      <rect x={34} y={212} width={74} height={8} rx={4} fill={C.raised} />
    </svg>
  );
}

/** Transparency: a ledger of public totals, with the one row that stays private sealed in green. */
export function LedgerArt() {
  const rows = [
    { label: 92, value: 128 },
    { label: 70, value: 96 },
    { label: 110, value: 74 },
  ];
  return (
    <svg width={324} height={190} viewBox="0 0 324 190">
      {rows.map((r, i) => {
        const y = 14 + i * 44;
        return (
          <g key={i}>
            <rect x={4} y={y} width={r.label} height={14} rx={7} fill={C.line} />
            <rect x={320 - r.value} y={y} width={r.value} height={14} rx={7} fill={C.paper} />
            <path d={`M4 ${y + 30} H320`} stroke={C.raised} strokeWidth={1.5} strokeDasharray="4 7" />
          </g>
        );
      })}
      <rect x={4} y={146} width={84} height={14} rx={7} fill={C.line} />
      <rect x={180} y={140} width={140} height={26} rx={13} fill={C.tintSoft} stroke={C.tintLine} strokeWidth={1.5} />
      <rect x={198} y={150} width={104} height={6} rx={3} fill={C.tint} />
    </svg>
  );
}

/** Research, agent payments: a price comes in, gets checked, and is paid with the amount hidden. */
export function GuardArt() {
  return (
    <div style={{ ...col, width: 320, gap: 14 }}>
      <div
        style={{
          ...row,
          alignSelf: "flex-start",
          padding: "14px 20px",
          borderRadius: "20px 20px 20px 6px",
          border: `1.5px solid ${C.line}`,
          background: C.surface,
        }}
      >
        <Text size={22}>402: pay 2 USDG</Text>
      </div>
      <div style={{ ...row, alignSelf: "center", gap: 10, padding: "10px 18px", borderRadius: 16, border: `1.5px dashed ${C.line}` }}>
        <Check size={18} color={C.mute} />
        <Text size={20} color={C.mute}>
          Checked: allow
        </Text>
      </div>
      <div
        style={{
          ...row,
          alignSelf: "flex-end",
          gap: 10,
          padding: "14px 20px",
          borderRadius: "20px 20px 6px 20px",
          border: `1.5px solid ${C.tintLine}`,
          background: C.tintSoft,
        }}
      >
        <Check size={20} color={C.tint} />
        <Text size={22} color={C.tint}>
          Paid, amount hidden
        </Text>
      </div>
    </div>
  );
}

/** Virtuals agents: the Gloam worker's functions, the private payment one in green. */
export function WorkerArt() {
  const names = ["gloam_private_balance", "gloam_add_privately", "gloam_pay_privately", "gloam_prove_funds"];
  return (
    <div
      style={{
        ...col,
        gap: 4,
        width: 330,
        padding: "14px 10px",
        borderRadius: 20,
        border: `1.5px solid ${C.line}`,
        background: C.surface,
      }}
    >
      {names.map((n) => {
        const on = n === "gloam_pay_privately";
        return (
          <div
            key={n}
            style={{
              ...row,
              justifyContent: "space-between",
              height: 50,
              padding: "0 14px",
              borderRadius: 12,
              border: `1.5px solid ${on ? C.tintLine : "transparent"}`,
              background: on ? C.tintSoft : "transparent",
            }}
          >
            <Text size={20} color={on ? C.tint : C.mute} style={{ whiteSpace: "nowrap" }}>{n}</Text>
            {on && <Hidden n={3} d={7} gap={5} />}
          </div>
        );
      })}
    </div>
  );
}

/** Research, agent commerce: one ACP job on an explorer, the job public and the payouts sealed. */
export function JobArt() {
  const line = (label: string, value: ReactNode, sealed = false) => (
    <div
      style={{
        ...row,
        justifyContent: "space-between",
        height: 52,
        padding: "0 16px",
        borderRadius: 12,
        border: `1.5px solid ${sealed ? C.tintLine : "transparent"}`,
        background: sealed ? C.tintSoft : "transparent",
      }}
    >
      <Text size={21} color={sealed ? C.tint : C.faint}>{label}</Text>
      {value}
    </div>
  );
  return (
    <div
      style={{
        ...col,
        gap: 6,
        width: 330,
        padding: "12px 10px",
        borderRadius: 20,
        border: `1.5px solid ${C.line}`,
        background: C.surface,
      }}
    >
      {line("Job", <Text size={21}>Client to provider</Text>)}
      {line("Fee", <Text size={21}>0.05 USDC</Text>)}
      {line("Payout", <Hidden n={4} d={8} gap={6} />, true)}
      {line("Payout", <Hidden n={4} d={8} gap={6} />, true)}
    </div>
  );
}

/** Video contest: a video frame with a play mark, and a progress line under it. */
export function PlayArt() {
  return (
    <div style={{ ...col, alignItems: "center" }}>
      <div
        style={{
          ...row,
          justifyContent: "center",
          width: 300,
          height: 172,
          borderRadius: 22,
          border: `1.5px solid ${C.line}`,
          background: C.surface,
        }}
      >
        <div
          style={{
            ...row,
            justifyContent: "center",
            width: 72,
            height: 72,
            borderRadius: 36,
            background: C.tintSoft,
            border: `1.5px solid ${C.tintLine}`,
          }}
        >
          <svg width={28} height={28} viewBox="0 0 24 24" style={{ marginLeft: 4 }}>
            <path d="M7 4.5v15l12-7.5z" fill={C.tint} />
          </svg>
        </div>
      </div>
      <div style={{ ...row, gap: 10, marginTop: 22 }}>
        <Bar w={120} h={8} color={C.paper} />
        <Bar w={168} h={8} />
      </div>
    </div>
  );
}
