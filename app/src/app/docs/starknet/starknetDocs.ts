/**
 * What the docs say about Starknet, in one place: its name for this build and
 * the one privacy line. Every docs page shows these only while
 * NEXT_PUBLIC_STARKNET_ENABLED is on (lib/starknetPrivacy/config STARKNET_ENABLED).
 */
import { STARKNET_PRIVACY_NOTE } from "@gloamtrade/sdk";
import { STARKNET_NETWORK } from "@/lib/starknetPrivacy/config";

/** "Starknet", "Starknet Sepolia" or "Starknet devnet", as the app names it. */
export const STARKNET_DOCS_NAME = STARKNET_NETWORK === "mainnet" ? "Starknet" : STARKNET_NETWORK === "sepolia" ? "Starknet Sepolia" : "Starknet devnet";

/** The plain line: what a payment hides and shows there, the auditor key and the prover (the SDK's own words). */
export const STARKNET_DOCS_NOTE = STARKNET_PRIVACY_NOTE;
