import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { liveMainnetNames } from "@/lib/mainnet";

// The chains come from lib/mainnet, so a new mainnet shows up here when its pool is filled in.
export const alt = `Gloam is live on mainnet: private payments on ${liveMainnetNames()}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const asset = (f: string) => join(process.cwd(), "src/assets/og", f);

/** One line under the title: with four or five mainnets in it runs long, so it steps down a size (two with Elysium) instead of wrapping under the etching. */
const LINE = `Private payments on ${liveMainnetNames()}`;
const LINE_SIZE = LINE.length > 64 ? 28 : LINE.length > 48 ? 32 : 38;

/** Mainnet share card: the home card, saying mainnet is live and on which chains. */
export default async function OpenGraphImage() {
  const [light, medium, etching] = await Promise.all([
    readFile(asset("Aeonik-Light.ttf")),
    readFile(asset("Aeonik-Medium.ttf")),
    readFile(asset("etching-og.jpg")),
  ]);
  const etchingSrc = `data:image/jpeg;base64,${etching.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#000000",
          fontFamily: "Aeonik",
          position: "relative",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "64px 72px 0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                position: "relative",
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "#F4F5F6",
                display: "flex",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 20.6,
                  top: 5.5,
                  width: 16.5,
                  height: 16.5,
                  borderRadius: 5,
                  background: "#000000",
                  display: "flex",
                }}
              />
            </div>
            <div
              style={{
                color: "#F4F5F6",
                fontSize: 30,
                fontWeight: 500,
                letterSpacing: "-0.015em",
                display: "flex",
              }}
            >
              Gloam
            </div>
          </div>
          <div
            style={{
              marginTop: 44,
              fontSize: 82,
              lineHeight: 1.02,
              fontWeight: 300,
              letterSpacing: "-0.028em",
              color: "#F4F5F6",
              display: "flex",
            }}
          >
            Live on mainnet
          </div>
          <div
            style={{
              marginTop: 18,
              maxWidth: 1000,
              fontSize: LINE_SIZE,
              lineHeight: 1.2,
              fontWeight: 300,
              letterSpacing: "-0.015em",
              color: "#A9AEB5",
              display: "flex",
            }}
          >
            {LINE}
          </div>
        </div>
        <img
          src={etchingSrc}
          alt=""
          width={1200}
          height={300}
          style={{ position: "absolute", left: 0, bottom: 0, width: 1200, height: 300 }}
        />
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Aeonik", data: light, weight: 300, style: "normal" },
        { name: "Aeonik", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
