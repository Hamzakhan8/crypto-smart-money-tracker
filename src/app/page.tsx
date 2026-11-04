import type { Metadata } from "next";
import { MarketFlow } from "@/components/market-flow/MarketFlow";
import "./globals.css";

export const metadata: Metadata = { title: "Market Flow Radar" };

export default function Page() {
  return <MarketFlow />;
}
