"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

type Props = Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string };

/**
 * A link whose page is fetched when someone points at, focuses or touches it,
 * not as soon as the link scrolls into view. A plain Link prefetches every
 * page it can see the moment the page has loaded: on a phone that is a dozen
 * pages and their scripts, downloaded while the page itself is still starting.
 * The click itself works exactly like a Link.
 */
export function IntentLink({ href, onMouseEnter, onFocus, onTouchStart, ...rest }: Props) {
  const router = useRouter();
  const warm = () => router.prefetch(href);
  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onMouseEnter={(e) => {
        warm();
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        warm();
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        warm();
        onTouchStart?.(e);
      }}
    />
  );
}
