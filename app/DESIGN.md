# Gloam design system

Calm, monochrome and plain, in the spirit of zama.ai: ink and paper, one green
tint for what is private, Aeonik for everything, and dark mode as first-class
as light. The short version: **use space, say less, keep one action per
screen, and never stamp "private" on everything.**

The tokens live in `src/app/globals.css`. This file says how to use them.

## Colour

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Ink | `#0B0C0E` | `#F4F5F6` | Text and the one primary action (`btn-ink`, `text-foreground`) |
| Paper | `#FFFFFF` | `#08090A` | Page background (`bg-background`) |
| App ground | `#F4F4F5` | `#08090A` | Behind app cards (set by `.gloam-app`) |
| Panel | `#FFFFFF` | `#111214` | Cards (`bg-panel`) |
| Surface | `#F3F4F5` / `#EAEBED` | `#17181B` / `#1E2023` | Fields, rows, inner tiles (`bg-surface`, `bg-surface-2`) |
| Soft, mute, faint | `#34373C`, `#5F636A`, `#6B6F76` | `#CDD0D4`, `#9B9FA6`, `#83878E` | Body copy, secondary copy, hints. Faint still passes AA on panel, app ground and surface |
| Line | `#E4E6E9` / `#CFD2D6` | `#232529` / `#33363B` | Hairlines (`border-line`, `border-line-strong`) |
| Sealed green | `#2E7D53` (brand); `#2C774F` as the `--sealed` token, so 12px text passes AA on every light surface | `#8FD3AD` | Private, sealed or verified, and nothing else (`text-sealed`, `bg-sealed-soft`) |
| Warn, danger | `#8A5A12`, `#B4362A` | `#E8B86A`, `#F08A7E` | States only: a warning or an error |

- **Green is a tint, not an accent.** Use it only where something is private, sealed or verified, and keep it under 5% of a screen. Buttons, links, nav and marketing calls to action are never green.
- **No other hues.** No indigo, purple, blue or yellow accents. Warn and danger are for states, not decoration.
- The legacy `--lime` and `--navy*` slots now alias ink and greys. Don't build anything new on them.
- Every colour comes from a token, so dark mode is automatic. Don't use raw hex in components; logos and the OG cards (`lib/docsCard`) are the exception.

## Type

One family, Aeonik, self-hosted. Light (300) for display, Regular and Medium for UI.

| Class | Size | Use |
| --- | --- | --- |
| `t-display-xl` | 42 to 76 | One per page: the landing hero, a section's big statement, /research |
| `t-display-l` | 32 to 48 | Page and post titles on the site |
| `t-display-m` | 26 to 34 | App page titles, section heads |
| `t-title` | 20 | Card titles |
| body | 15 to 18 | 17 to 18 for reading (`.article-prose`, `.docs-prose`), 14 to 15 in the app |
| `t-label` | 11 caps | Rare. Not every label is caps: a card title, a meta line or a form label is sentence case |

- Money is `tnum`, light weight when large, and never truncated mid-number (`formatUsdCompact`).
- Keep display lines to one or two lines, with `text-wrap: balance`.

## Shape

| Radius | Where |
| --- | --- |
| 999 (pill) | Buttons (`.btn`), chips (`.gl-chip`), segmented controls |
| 12 | Rows, list items, inner panels |
| 14 | Inputs (`.gl-input`, `.gl-inputwrap`) |
| 18 | Cards (`.gl-card`) |
| 20 | Big amount fields (`.gl-inputcard`), glass rims (`.gl-glass`: 8px of glass around a 12px panel, so the curves stay concentric) |
| 24 | Feature panels with the sealed field (`.gl-panel`) |

A box inside a box takes the outer radius minus the padding between them.

## Components

- **Buttons** (`.btn`, pill, 44px, `btn-sm` 36px, `btn-lg` 48px):
  - `btn-ink` is the one primary action on a screen.
  - `btn-ghost` (outlined) is a real second action.
  - `btn-quiet` is anything else. Prefer it over a second outlined button next to an ink one.
  - `btn-danger` is for destructive confirms only.
  - Buttons never move on hover; they change tone. Only `.btn:active` presses in a touch.
- **Cards** (`.gl-card`): panel, hairline, `shadow-card`, radius 18, `p-5` to `p-7`. A clickable card firms its edge on hover (`.lift`) and never lifts.
- **Fields**: `.gl-input` for text, `.gl-inputcard` for the big amount fields, `.gl-chip` for small picks (25%, Max). Dropdowns use the shared Gloam dropdown, never a native `<select>`.
- **Sealed field** (`SealedField` in a `.gl-panel`): the one luminous surface. It signals privacy in the app and carries covers on the site. Use one per screen at most.
- **Status**: one clear signal. No "Private" pill on every row and no "Public" pill on every card. Say it once in the card title or the empty state.
- **Icons**: bare strokes at 1.5 to 1.8 weight in `currentColor`, with no tile or circle behind them. Real logos come from `TokenLogo` and `public/brand/logos`, never a monogram when the real mark exists.

## Layout

- The site container is `max-w-[1400px] px-4 sm:px-7`, the same as the header. Every section aligns to it.
- Reading columns are 680 to 720px (`ArticleLayout`, docs).
- The app frame (`AppShell`) is a floating sidebar on desktop and a top bar with a sheet on phones. Content sits in `max-w-[1120px]`. The page header is the title on the left, one short line under it, and at most one action on the right.
- App navigation:
  - Portfolio
  - Vault, with its actions listed under it: Add privately, Pay privately, Receive, Swap, Cash out, Agent top-ups, then Trade and Public send where the network has them
  - Payroll
  - Markets, on stock networks
  - Prove
  - Settings and Docs at the foot

  Every action is a deep link (`lib/vaultNav`). The Portfolio quick actions use the same names.
- Solana is picked in the same network menu, but it is not an EVM network: it keeps the EVM network underneath and the pages show their Solana side (`SolanaOr`, `components/app/Solana*`). It has Portfolio, Vault with Add privately, Pay privately, Receive and Cash out, and Payroll, drawn with the same cards and rows. What it doesn't have yet leaves the nav, or says so plainly.
- For row and column swaps, use real media queries (`.gl-sidebar`, `.gl-pagehead`), not `hidden lg:flex`. Webpack dev can drop the variant.
- Mind the touch targets: 40px for anything tappable on a phone, and visible focus rings everywhere.

## Writing

Plain language, short sentences, no jargon on screen:
- Say private balance, not note.
- Say Gloam address, not receive tag.
- Say claim link and cash out.
- Say mainnet and testnet, with no gloss.

No em dashes, no hype, never "happy to". Keep the product verbs: Add privately, Pay privately, Receive, Swap, Cash out, Prove.

## The anti-slop law

Read `https://pols.dev/slop.md` before any UI work. The tells this product has slipped into before:

- A filled button next to an outlined one as the default action row
- A tinted pill on every piece of metadata, and an icon sitting in a coloured circle
- The same tracked-caps label on every heading, eyebrow and footer title
- A card that lifts and blooms a shadow on hover, and a pulsing "live" dot as decoration
- Content that starts at opacity 0 and waits for a script to show it
- Tabs inside tabs
- A nav label that doesn't match its page title
