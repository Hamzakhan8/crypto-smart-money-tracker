import type { Metadata } from "next";
import { ScreenerShell } from "@/components/screener/ScreenerShell";
import "./screener.css";

export const metadata: Metadata = { title: "Early Setup Screener" };

export default function Page() {
  return <ScreenerShell />;
}
