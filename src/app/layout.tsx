import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Each page loads its own styles (the classic pages' look): globals.css for / and /ai, screener.css for /screener.

export const metadata: Metadata = { title: "Smart Money Tracker", description: "Crypto research dashboard: market flow, ignition alerts, whale signals. Research, not financial advice." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
