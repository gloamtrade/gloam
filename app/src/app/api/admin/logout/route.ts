import { NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/lib/adminAuth";
import { sameSiteJson } from "@/lib/partnersAuth";

/** Signs the admin out. A JSON request from this site only, so another site can't sign the admin out. */
export async function POST(req: Request) {
  if (!sameSiteJson(req)) {
    return NextResponse.json({ ok: false, error: "Sign out from the Gloam admin page." }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true });
  const secure =
    process.env.NODE_ENV === "production" &&
    process.env.ADMIN_COOKIE_INSECURE !== "true";
  res.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
