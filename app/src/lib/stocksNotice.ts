/**
 * The "Private stocks are live" notice in the app (components/app/StocksLiveNotice):
 * where its closed flag is kept, and the small script that decides its first paint.
 *
 * Plain logic with no React, so scripts/selftest-stocks-notice.mts runs the script
 * against NetworkProvider's own reading of the network.
 */
import { DEFAULT_NETWORK_KEY, NETWORK_KEYS, getNetwork } from "./networks";

/** Set to "1" in localStorage once the notice is closed in this browser. */
export const STOCKS_NOTICE_KEY = "gloam.notice.stocks-live.v1";
/** The network the notice is about, and the Swap it points to. */
export const STOCKS_NOTICE_MAINNET = "robinhood-mainnet";
/** The notice's element, sent hidden in the server's HTML. */
export const STOCKS_NOTICE_ID = "gl-stocks-live";
/** Where NetworkProvider keeps the network this browser picked. */
export const NETWORK_STORAGE_KEY = "gloam.network";

/**
 * Runs right after the notice in the page, before the app's JavaScript: shows it
 * when this browser will show it, so it is part of the first paint and nothing
 * under it moves later. The network is read the way NetworkProvider reads it (the
 * one picked here, else the first mainnet, lib/networks defaultNetworkKey), then
 * the notice's rules: not closed here, not a testnet, not already on the Swap.
 * Anything it can't read leaves the notice hidden.
 */
export function stocksNoticeRevealScript(keys: readonly string[] = NETWORK_KEYS): string {
  const testnets = keys.filter((k) => getNetwork(k as never).testnet);
  const fallback = keys.find((k) => !getNetwork(k as never).testnet) ?? DEFAULT_NETWORK_KEY;
  const j = JSON.stringify;
  return `(function(){try{if(localStorage.getItem(${j(STOCKS_NOTICE_KEY)})==='1')return;var k=${j(keys)},t=${j(testnets)},n=localStorage.getItem(${j(NETWORK_STORAGE_KEY)});if(k.indexOf(n)<0)n=${j(fallback)};if(t.indexOf(n)>=0)return;if(n===${j(STOCKS_NOTICE_MAINNET)}&&location.pathname==='/app/vault'&&new URLSearchParams(location.search).get('tab')==='swap')return;var el=document.getElementById(${j(STOCKS_NOTICE_ID)});if(el)el.hidden=false}catch(e){}})()`;
}
