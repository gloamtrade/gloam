import type { Metadata } from "next";
import { Landing } from "@/components/Landing";
import { HuntSourceClue } from "@/components/hunt/HuntSourceClue";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <>
      <Landing />
      <HuntSourceClue />
    </>
  );
}
