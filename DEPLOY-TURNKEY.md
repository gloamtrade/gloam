# Turn on Gloam wallets (Turnkey)

The runbook for switching on Gloam wallets: sign in with an email or a passkey, create
a wallet in one step, then add funds. The wallet's key is made and kept by Turnkey in
secure hardware; the page never sees it and there is no seed phrase. Signing in on any
device opens the same wallet.

Gloam wallets are live on gloam.trade since 5 November 2026 (`NEXT_PUBLIC_TURNKEY_ENABLED=true`
on Vercel). This runbook is the record of that switch-on and the reference for its settings;
[Rolling back](#rolling-back) is at the end. You set up the Turnkey
dashboard yourself; no agent creates accounts or enters credentials there. Gloam's
servers hold no Turnkey secret: the app talks to Turnkey only through its auth proxy,
with public ids.

## Why sign-in failed before

The auth proxy config only allowed `http://localhost:3000`. From `https://www.gloam.trade`
(where `gloam.trade` redirects) the proxy answered `403 origin not allowed`.
`@turnkey/react-wallet-kit` 2.2.0 swallows that failure, never starts its client, and
its sheet then only says "An underlying error occurred. Try refreshing the page". The
fix is the Allowed Origins setting below. The app now also hides email and passkey
sign-in on any page where the kit fails to start (it offers a browser wallet instead and
logs the reason), and `app/scripts/turnkey-check.mjs` checks the setting before launch.

## 1. Turnkey dashboard

The organization and its auth proxy config already exist (their ids are in Vercel).
In the Turnkey dashboard, under **Embedded Wallets > Configuration**:

| Setting | Value |
| --- | --- |
| Auth proxy | Enabled |
| Allowed Origins | `https://www.gloam.trade`, `https://gloam.trade`, and `http://localhost:3000` for development. Exact URLs: no wildcard, no path, no trailing slash. A Vercel preview needs its own exact URL added before sign-in works there. |
| Email OTP | On |
| Passkey | On |
| Wallet sign-in, SMS | Off. The app hides them anyway: browser wallets connect through the app's own "Use a browser wallet". |
| Google | On only for Continue with Google, with its Web client ID (see "Continue with Google" below). Other social logins: Off. |
| Session expiration | 86400 (one day) is a reasonable start. Today it is 900 (15 minutes). The app refreshes a session while the page is open; a longer session means fewer sign-ins, and longer access for anyone holding the unlocked browser. |
| OTP | 6 digits is fine. Letters and digits (up to 9) is stronger. |
| Email customization | App name `Gloam`; logo `https://www.gloam.trade/brand/logo.png` (PNG, at most 340x124). The app name is required for email sign-in. |
| OAuth redirect URL | Empty without Google. With Google: `https://www.gloam.trade`. The app sends the page's own origin, so this is only a fallback. |

Wallets are not created at sign-up. After the first sign-in the app reads the wallet
list (a failed read is retried, never taken for "no wallet"), then asks for an optional
name and creates one Ethereum wallet (`m/44'/60'/0'/0/0`), which signs on every chain
Gloam runs on. It reads the list once more just before creating, and with more than one
wallet it always signs with the oldest.

### Continue with Google (optional)

The sign-in sheet shows a Google button only when `NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID`
is set **and** Google is on in the auth proxy config. Unset, nothing about Google ships.

How it works (`handleGoogleOauth({ openInPage: false })` in `@turnkey/react-wallet-kit`
2.2.0): the kit opens a **popup** (500x600) on `accounts.google.com` and asks for an ID
token (`response_type=id_token`, scopes `openid email profile`, the nonce bound to a fresh
session key). Google sends the popup back to this site's own origin with the token in the
address (after the `#`). The page that opened the popup reads that address, closes the
popup and finishes the sign-in through the auth proxy (`completeOauth`). No client secret
is used anywhere.

- The redirect URI is the page's origin itself: `https://www.gloam.trade`, `https://gloam.trade`,
  `http://localhost:3000` or the preview's origin, with no path and no trailing slash
  (`oauthRedirectFor` in `lib/embeddedWallet`). The popup only lands there for a moment.
- Popup on phones too. The kit's default on narrow screens is a whole-page redirect, but
  the origin's root (the marketing page) doesn't run the kit, so that flow could not finish.
  If a phone browser blocks the popup, the sheet says how to allow pop-ups.
- Vercel Analytics never sees the token: it sends the origin and path only.

**Google finds accounts by the Google identity, not by the email address.** Someone who
signed up with the email code and later uses Google with the same address gets a new
Gloam account and a new wallet. The sheet keeps the email field first for that reason.

**1. Google Cloud** (done for project `gloam-sign-in`, published to production; for reference):

1. Google Auth Platform > **Branding**: App name `Gloam`; support email `hello@gloam.trade`;
   logo `app/public/brand/logo.png`; home page `https://www.gloam.trade`; privacy policy
   `https://www.gloam.trade/privacy`; terms `https://www.gloam.trade/terms`; authorized
   domain `gloam.trade`.
2. **Audience**: External, published ("In production"). While it is in Testing only listed
   test users can sign in. The scopes are the basic ones (`openid`, `email`, `profile`).
3. **Clients**: a **Web application** client. Authorized JavaScript origins **and**
   Authorized redirect URIs both list, exactly (no path, no trailing slash):
   - `https://www.gloam.trade`
   - `https://gloam.trade`
   - `http://localhost:3000`
   - `https://gloam-trade-git-feat-gloam-signin-sheet-duke-s-team.vercel.app` (this PR's
     preview; add each new preview origin the same way, Google allows no wildcards)
4. Copy the **Client ID**. The client secret is not used; leave it in Google.

**2. Turnkey dashboard**, Embedded Wallets > Configuration (the same auth proxy config):

1. Turn **Google** on under the social logins and paste the same Client ID as Google's
   client ID. The auth proxy checks the ID token against it (the token's audience).
2. OAuth redirect URL: `https://www.gloam.trade`. It is only a fallback: the app sends
   the page's own origin.
3. Allowed Origins: unchanged, plus any preview you test Google on.
4. The **OAuth 2.0** tab needs nothing for Google. It holds client secrets for providers
   that exchange a code on Turnkey's side (X, Discord, Facebook). Google's ID token flow
   has no code and no secret, and the issuer (`https://accounts.google.com`) is not
   something to register.

**3. Vercel**: `NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID` for Production and Preview (set),
then redeploy.

**4. Check**: run `scripts/turnkey-check.mjs` with `NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID`
set as well. It fails if Google is off in the config or holds a different client ID.

Content Security Policy: no change. Google is only ever a popup (a navigation, which the
policy does not cover), the token comes back in the address on our own origin, and it
goes to `*.turnkey.com`, which is already allowed. `csp.config.mjs` says the same, and
`scripts/selftest-csp.mts` checks it.

### Recovery for Gloam wallets

A Gloam wallet's signatures are made by Turnkey and kept as activity results, which
Gloam's Turnkey account can read. A recovery key made from one could be rebuilt without
the person, so the app offers recovery with a passkey (WebAuthn PRF) instead: one tap,
once per wallet per browser, only while the Gloam wallet is connected. Nothing turns on
by itself. Where the browser can't make a passkey backup, the app offers the wallet's
signature and says plainly that Turnkey could open that backup; Settings and `/privacy`
say the same.

### Gas sponsorship (optional)

A new Gloam wallet holds no gas. Claiming a link, receiving a private payment, paying
privately, cashing out and a bridge order paid from Solana or another wallet need none
from it. Adding money privately from the wallet's own public balance does. Turnkey's gas
station can pay that fee, on Robinhood Chain, Base and Ethereum (mainnet and testnet).
It pays for two calls only: the deposit into that chain's Gloam vault, and the approve,
on a token Add privately lists there, that lets the vault take it. It never pays for a
call whose gas estimate fails. A
public send or a bridge order paid from the wallet is the wallet's own to pay for. On
Tempo the fee always comes out of the stablecoin.

To turn it on:

1. In the dashboard, turn on **Gas Sponsorship**.
2. Set an organization-wide limit and a per-sub-organization limit (each Gloam wallet
   is its own sub-organization). Suggested start: $0.50 per wallet per 30 days, and an
   organization cap you are comfortable losing to abuse: anyone with an email can make
   a wallet and spend up to the per-wallet limit. Pay-as-you-go plans cap sponsorship
   at $10 a month and Pro at $25 a month.
3. Set `NEXT_PUBLIC_TURNKEY_SPONSOR_CHAINS` (below).

The app sponsors a send only when the wallet can't pay its own fee, so a wallet that
holds ETH pays its own way. Only a refusal Turnkey answers to the first submit (a 4xx
whose `turnkeyErrorCode`, or with none its gRPC code, says it was turned down before any
work) counts as "nothing was sent"; a 5xx, an unknown code, a lost answer, or anything
after Turnkey took the send keeps the note the app saved ahead of it, because the deposit
may still land. A sponsored wallet delegates to Turnkey's open-source gas
delegate (`0x955D84139e7621bc571b117D8EB5D28A4A222C6f`, EIP-7702); the cash-out check
treats it as a known delegate. A sponsored deposit made soon after money arrived still
reads as a sweep on chain (Turnkey's paymaster sent it, and its relayers can't be told
apart from anyone else's), so a cash out to that address shows the sweep warning, except
to the person's own connected Gloam wallet, which gets a quieter note and no hold.

## 2. Vercel environment

All public, all build-time: redeploy after any change.

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID` | The organization id (already set) |
| `NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID` | The auth proxy config id (already set) |
| `NEXT_PUBLIC_TURNKEY_ENABLED` | `true` to switch Gloam wallets on. Unset or anything else: off |
| `NEXT_PUBLIC_TURNKEY_SPONSOR_CHAINS` | Optional. Chain ids Turnkey may sponsor, comma-separated, or `all`. Suggested: `4663,8453,46630,84532,11155111`. Add `1` (Ethereum mainnet) only with a limit you accept: its fees are the highest. Unset sponsors nothing. |

With the flag on, production builds also enforce a Content-Security-Policy on `/app`
(scripts, frames, workers and connections only from the listed hosts, `csp.config.mjs`),
because a Gloam wallet signs with no prompt. Still open: inline scripts, until Next's
scripts carry nonces. Test 11 below checks it on the preview.

## 3. Check before switching on

From `app/`, with the two ids:

```
NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID=... NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID=... node scripts/turnkey-check.mjs
```

It asks the auth proxy for the wallet kit config as each origin's browser would, and
prints `ok` or `FAIL` per origin. Every production origin must say `ok`, with email and
passkey on. It needs no secret and changes nothing.

## 4. Test by hand (on a preview first)

Add the preview's exact URL to Allowed Origins, set the variables on that preview, then:

1. Robinhood Chain testnet: Sign in with an email. The code arrives from Turnkey with the
   Gloam name and logo. The create sheet opens: leave the name empty, Create wallet. Add
   funds opens; the menu shows the address.
2. Sign out from the wallet menu, sign in again with the same email: the same address,
   no create sheet.
3. Sign in with a passkey on a second browser (a new account): create a wallet with a name.
4. In Add funds, "Back up with a passkey": the passkey prompt opens, then the sheet says
   it is backed up and Settings > Recovery shows "With a passkey". Get test funds, add
   privately, then sign in on another browser profile with the same email: the backup
   sheet offers "I backed up before"; use the same passkey and the private balance comes
   back. Sign in on a browser that already backs up: no offer, and nothing says "backed
   up" for it. In a browser with no passkey support, the offer is the wallet's signature,
   with the warning that Turnkey could open it.
5. Claim a payment link sent from another wallet: it lands with no gas in the Gloam wallet.
6. Switch networks in the menu (Tempo testnet, Base Sepolia, Ethereum Sepolia, then each
   mainnet): the wallet follows with no prompt and the same address.
7. With sponsorship on: on Base Sepolia, send test USDC to the wallet (no ETH), Add
   privately: approve and deposit go through, and Turnkey's dashboard shows the gas.
   A public send from the same wallet is not sponsored: the app says it has no ETH for
   the fee and sends nothing. Without sponsorship, Add privately says the same. Right
   after, cash out to "my wallet": a quiet note under it, not the sweep warning.
8. Tempo testnet: send test stablecoins to the wallet, Add privately: the first send sets
   a fee token, then the deposit goes through with the fee taken in the stablecoin.
9. Bridge: on a mainnet, Add funds > Bring money from another chain opens the bridge.
10. Turn Allowed Origins off for the preview (or open a URL not in the list), then tap
    Sign in: the sheet says email and passkey sign-in isn't available here and offers the
    browser wallet, the header then offers Connect wallet only, and the console names the
    origin to add. (The kit loads only on Sign in, so before the tap the page can't know.)
11. With the flag on, open `/app` pages, sign in, add privately (which makes a proof) and
    connect a browser wallet and WalletConnect: the console shows no "Refused to load" or
    "Refused to connect" line. If one does, add that host in `csp.config.mjs`. One line is
    expected and harmless on /app/move, /app/payroll and /app/settings: "Evaluating a
    string as JavaScript violates the following Content Security Policy directive". A
    bundled library (is-generator-function) tests for eval inside a try, falls back, and
    nothing breaks.
12. If the wallet doesn't open after sign-in, the header offers Try again and Sign out.
13. Partner portal: on `/partners`, Sign in with email opens the portal and the email
    sheet. A new email gets Create Gloam wallet, then lands signed in. Sign out, sign in
    again: the same partner account. With the flag off, only Connect wallet shows.
    Closing the email sheet, or "Use a browser wallet" in it, lands back on the
    Sign in card with both ways in, and `?with=email` is gone from the address.
14. The sign-in sheet (Gloam's own, `GloamSignInSheet`): the code email arrives and the
    6 boxes take a paste of the whole code and the browser's one-time-code fill (iOS
    Mail and Gmail suggestions), then sign in on the 6th digit. A wrong code says so and
    clears; Resend opens after 30 seconds; an old code says it expired and offers a new
    one. Passkey signs in on a browser that has one; closing the passkey prompt moves
    to the passkey step (as in 15), signing nothing in. Back on the code step returns to
    the email with it still filled in. The "Use a browser wallet" button under Google and
    Passkey closes the sheet and opens the usual wallet connect; with no browser wallet
    found it is not shown.
15. Passkey on a browser with no Gloam passkey: the prompt finds none, and the sheet
    offers Create a passkey and "I have one. Try again". Create makes a new account.
16. With Google set up: Google opens in a popup, and the sheet closes once you are signed
    in (on `/app`, and on the partner portal, which then signs the partner message by
    itself). Closing the popup says so. With pop-ups blocked, the sheet says how to allow
    them. Try it on an iPhone (Safari) and an Android phone (Chrome): the popup must open
    there too. Sign in with Google using an email that already has a Gloam account: a
    second account and wallet, as described above.
17. The kit loads only when it is needed (TurnkeyKitGate). In a fresh private window,
    `/app` makes no request to turnkey.com until Sign in is tapped; the button shows a
    spinner until the sheet opens, and Continue works once "Getting sign-in ready…" is
    gone. Signed in, reload `/app`: the header says "Opening your wallet…" from the
    first paint, then shows the address, never Sign in in between. Sign out, reload:
    Sign in again, and no request to turnkey.com.

## Rolling back

Unset `NEXT_PUBLIC_TURNKEY_ENABLED` (or set it to anything but `true`) and redeploy.
Wallets stay in Turnkey and open again when it is back on. A private balance stays in
the browser and in its recovery backup either way.
