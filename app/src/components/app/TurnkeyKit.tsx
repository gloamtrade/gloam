"use client";

import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  TurnkeyProvider,
  type TurnkeyProviderConfig,
} from "@turnkey/react-wallet-kit";
import {
  TURNKEY_AUTH_PROXY_CONFIG_ID,
  TURNKEY_GOOGLE_CLIENT_ID,
  TURNKEY_ORGANIZATION_ID,
  embeddedRpId,
  oauthRedirectFor,
} from "@/lib/embeddedWallet";
import { TurnkeyWagmiSync } from "./TurnkeyWagmiSync";
import { GloamSignInSheet } from "./GloamSignInSheet";
import { ClientOnly } from "./ClientOnly";

/**
 * Sign-in is Gloam's own sheet (GloamSignInSheet), so nothing opens the kit's
 * modal today. Its colours stay set in case a kit screen ever shows: they take
 * literal values, mirroring the Gloam tokens in globals.css.
 */
const TURNKEY_COLORS: NonNullable<
  NonNullable<TurnkeyProviderConfig["ui"]>["colors"]
> = {
  light: {
    primary: "#0B0C0E",
    primaryText: "#FFFFFF",
    button: "#F3F4F5",
    modalBackground: "#FFFFFF",
    modalText: "#0B0C0E",
    iconBackground: "#F3F4F5",
    iconText: "#5F636A",
    success: "#2E7D53",
    successText: "#FFFFFF",
    danger: "#B4362A",
    dangerText: "#FFFFFF",
  },
  dark: {
    primary: "#F4F5F6",
    primaryText: "#0B0C0E",
    button: "#17181B",
    modalBackground: "#111214",
    modalText: "#F4F5F6",
    iconBackground: "#1E2023",
    iconText: "#9B9FA6",
    success: "#8FD3AD",
    successText: "#0B0C0E",
    danger: "#F08A7E",
    dangerText: "#0B0C0E",
  },
};

/** Follows html[data-theme] so the Turnkey modal matches the app theme. */
function subscribeTheme(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => obs.disconnect();
}
const readDark = () => document.documentElement.dataset.theme === "dark";
const serverDark = () => false;

/**
 * The Turnkey embedded wallet provider itself, with the sign-in sheet and the
 * wallet sync on it. Loaded only when it is needed: in the app beside the pages,
 * for someone signed in or asking to sign in (TurnkeyKitGate, TurnkeyAppKit); on
 * the partner portal around the page (TurnkeyEmbeddedProvider). Never while Gloam
 * wallets are switched off.
 */
export default function TurnkeyKitProvider({ children }: { children: ReactNode }) {
  const dark = useSyncExternalStore(subscribeTheme, readDark, serverDark);
  // The kit builds its passkey signer once, from the config of the first render
  // in the browser, so the relying party is read then (it never reaches the page's
  // markup). On the server there is no host and no signer.
  const [rpId] = useState(() => (typeof window === "undefined" ? undefined : embeddedRpId(window.location.hostname)));
  // Continue with Google, when its client ID is set: Google sends its window back to
  // this origin, where the kit reads the token off the address (lib/embeddedWallet).
  const [oauthRedirectUri] = useState(() =>
    typeof window === "undefined" || !TURNKEY_GOOGLE_CLIENT_ID ? undefined : oauthRedirectFor(window.location.origin)
  );

  // Memoised so the provider only rebuilds its config when the theme flips,
  // not on every parent render.
  const config = useMemo<TurnkeyProviderConfig>(
    () => ({
      organizationId: TURNKEY_ORGANIZATION_ID,
      authProxyConfigId: TURNKEY_AUTH_PROXY_CONFIG_ID,
      ...(rpId ? { passkeyConfig: { rpId } } : {}),
      ...(oauthRedirectUri
        ? { auth: { oauthConfig: { oauthRedirectUri, google: { primaryClientId: TURNKEY_GOOGLE_CLIENT_ID } } } }
        : {}),
      // Browser wallets connect through wagmi, not the kit. The kit still needs
      // its wallet manager: refreshWallets asks it for providers first and throws
      // "Wallet manager is not initialized" without one, so the wallet list never
      // loads. `auth` can't do it: the kit replaces it with authModal's
      // walletAuthEnabled (false below). So `connecting` is on, and it needs at
      // least one wallet interface (the connector throws on none), so native
      // Ethereum is on too. Nothing calls the kit's connect flow; a browser wallet
      // already connected through wagmi can appear in the kit's list as
      // "connected", and every reader picks the Gloam wallet with
      // pickEmbeddedWallet, which takes embedded wallets only.
      walletConfig: {
        features: { auth: false, connecting: true },
        chains: { ethereum: { native: true }, solana: { native: false } },
      },
      ui: {
        darkMode: dark,
        logoLight: "/brand/logo.png",
        // the ink tile disappears into the dark sheet; the white tile keeps the mark visible
        logoDark: "/brand/kit/gloam-mark-white-1024.png",
        borderRadius: 16,
        preferLargeActionButtons: true,
        authModal: {
          // We offer wallet connect ourselves ("Use a wallet"), so drop it here.
          methods: { walletAuthEnabled: false },
          methodOrder: ["email", "passkey"],
        },
        colors: TURNKEY_COLORS,
      },
    }),
    [dark, rpId, oauthRedirectUri]
  );

  // One object for the provider's life: the kit's methods (refreshWallets, logout)
  // are rebuilt whenever this changes, and every page change re-renders this component.
  const callbacks = useMemo(
    () => ({ onError: (error: unknown) => console.error("[Gloam] Turnkey:", error) }),
    []
  );

  return (
    <TurnkeyProvider
      config={config}
      callbacks={callbacks}
    >
      <ClientOnly>
        <TurnkeyWagmiSync />
        <GloamSignInSheet />
      </ClientOnly>
      {children}
    </TurnkeyProvider>
  );
}
