import type { Metadata } from "next";
import { AiDesk } from "@/components/ai-desk/AiDesk";
import "../globals.css";

export const metadata: Metadata = { title: "AI Trade Desk" };

export default function Page() {
  return <AiDesk />;
}
