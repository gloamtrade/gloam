"use client";

/**
 * On the portfolio, for a signed-in account with no Gloam name yet: one short
 * card offering an @name, which is easier to share than a gloamr1 address. It
 * leads to the name form on Receive (GloamNameCard), where the price shows.
 * "Not now" closes it for this account (lib/nameOffer). Owned is the same rule
 * as the name card on Receive: the wallet holds a name, or a name pays one of
 * this account's Gloam addresses, found from this browser's saved names and the
 * registry's logs (lib/nameOwnership). A read that fails keeps the card hidden.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { IntentLink } from "@/components/IntentLink";
import { useAppAccount, useDemo } from "@/lib/demo";
import { GLOAM_NAMES_ADDRESS, loadMyNames } from "@/lib/gloamNames";
import { lookupGloamName } from "@/hooks/useGloamName";
import {
  GET_NAME_HREF,
  cachedNameOwned,
  closeNameOffer,
  nameOfferClosed,
  rememberNameOwned,
  shouldOfferName,
} from "@/lib/nameOffer";
import { accountOwnsName, namesHeldInLogs, registryLogReader } from "@/lib/nameOwnership";
import { getNetwork } from "@/lib/networks";
import { exportReceiveKeys, RECEIVE_TAG_PREFIX } from "@/lib/receiveTag";
import { publicClientFor } from "@/lib/rhClient";
import { useShownAccount } from "./AccountScope";

export function NameOfferCard() {
  const demo = useDemo();
  const { address, isConnected } = useAppAccount();
  const shownAccount = useShownAccount();
  const signedIn = Boolean(isConnected && address && shownAccount);
  const [closed, setClosed] = useState(true);
  const [owned, setOwned] = useState<boolean | null>(null);

  // the account's own state, read again when the account changes
  useEffect(() => {
    if (!signedIn || !address) return;
    let stale = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the closed flag lives in this account's browser storage; read on each account
    setClosed(nameOfferClosed());
    setOwned(null);
    void (async () => {
      const cached = cachedNameOwned();
      if (cached !== null) {
        if (!stale) setOwned(cached);
        return;
      }
      // this account's Gloam addresses, current and earlier, without making one
      const keys = await exportReceiveKeys().catch(() => ({ current: null, previous: [] }));
      const myTags = [keys.current, ...keys.previous].filter(Boolean).map((k) => RECEIVE_TAG_PREFIX + k!.publicSpkiB64);
      const rh = getNetwork("robinhood-mainnet");
      const owns = await accountOwnsName({
        address: address as Address,
        myTags,
        remembered: loadMyNames(),
        namesFromLogs: () => namesHeldInLogs(address as Address, registryLogReader(publicClientFor(rh), rh.logRange)),
        lookup: lookupGloamName,
      });
      if (stale) return;
      rememberNameOwned(owns);
      // unknown hides the card, the same as owned: never offer a name they may hold
      setOwned(owns === null ? true : owns);
    })();
    return () => {
      stale = true;
    };
  }, [signedIn, address]);

  if (!shouldOfferName({ registryLive: Boolean(GLOAM_NAMES_ADDRESS), demo, signedIn, closed, owned })) return null;

  return (
    <section
      aria-labelledby="name-offer-title"
      className="gl-card flex gap-4 max-sm:items-start max-sm:p-5 sm:items-center sm:py-4 sm:pl-6 sm:pr-4"
    >
      <span
        aria-hidden
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sealed-soft text-[16px] text-sealed"
      >
        @
      </span>
      <div className="flex min-w-0 flex-1 max-sm:flex-col max-sm:gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h2 id="name-offer-title" className="text-[15px] text-foreground">
            Get your @name
          </h2>
          <p className="mt-0.5 max-w-[62ch] text-[13px] leading-relaxed text-mute">
            People can pay @yourname instead of a long address.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 max-sm:self-start">
          <IntentLink href={GET_NAME_HREF} className="btn btn-ink btn-sm">
            Get a name
          </IntentLink>
          <button
            type="button"
            className="btn btn-quiet btn-sm text-mute"
            onClick={() => {
              closeNameOffer();
              setClosed(true);
            }}
          >
            Not now
          </button>
        </div>
      </div>
    </section>
  );
}
