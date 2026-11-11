"use client";

import { IntentLink } from "./IntentLink";

/**
 * A link from the marketing pages into /app. The app carries the wallet and
 * proof code, so it is fetched when someone points at, focuses or touches the
 * link, not as soon as the link scrolls into view. A phone reading the landing
 * or the docs never downloads the app unless it is about to open it.
 */
export const AppLink = IntentLink;
