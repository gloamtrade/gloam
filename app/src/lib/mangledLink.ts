/**
 * Short links whose "#" a chat app or an email client wrote as "%23":
 * gloam.trade/c%23<body> instead of gloam.trade/c#<body> (and /r for payment
 * requests). The browser then sends the body to the server in the path: it is
 * in that request's log, and there is no such page, so the 404 page opens.
 * That first request can't be taken back. What can be done is to stop there:
 * the 404 page puts the link back the way it was meant (/c#<body>, the body in
 * the fragment again) before anything else runs, and analytics cut a path at
 * "%23" as they do at "#" (lib/analyticsClean). "%2523" (the "%" escaped
 * again) is read the same way.
 */

/** A /c or /r path whose fragment was escaped into it: the page, then the body. */
export const MANGLED_SHORT_LINK = /^\/(c|r)\/?(?:%(?:25)*23)+([0-9A-Za-z]{8,})\/?$/i;

/** The link as it was meant ("/c#<body>"), for a mangled path; null for any other path. */
export function recoveredLink(pathname: string): string | null {
  const m = MANGLED_SHORT_LINK.exec(pathname);
  return m ? `/${m[1]!.toLowerCase()}#${m[2]}` : null;
}

/**
 * The 404 page's first script. On a mangled path it first takes the body out
 * of the address bar and history (the address becomes "/", so the next
 * request's Referer and any analytics see only the site), then opens the link
 * as it was meant: a request for /c alone, the body back in the fragment,
 * which no server sees. "/" and not "/c" on purpose: from /c, going to /c#...
 * would only change the fragment, and the 404 page would stay. Any other path
 * is left alone. Runs inline, before the page's own scripts and analytics.
 */
export const RECOVER_SCRIPT = `(function(){try{var m=${MANGLED_SHORT_LINK.toString()}.exec(location.pathname);if(!m)return;history.replaceState(null,"","/");location.replace("/"+m[1].toLowerCase()+"#"+m[2])}catch(e){}})();`;
