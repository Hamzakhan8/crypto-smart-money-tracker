import type { ReactNode } from "react";

// The bar at the top of every page. Pages not moved to React yet are plain links to the classic pages.
export const APPS: [href: string, label: string][] = [
  ["/", "Market flow"], ["/screener", "Ignition"], ["/screener#news", "News"], ["/screener#alpha", "Alpha"], ["/screener#early2x", "Early 2x"],
  ["/screener#perps", "Perps"], ["/screener#whales", "Whales"], ["/screener#liquidity", "Liquidity"], ["/screener#rotation", "BTC rotation"],
  ["/screener#journal", "Journal"], ["/ai", "AI desk"],
];

export function AppBar({ active, right }: { active: string; right?: ReactNode }) {
  return (
    <div className="appbar"><div className="appbar-in">
      <a className="brand" href="/"><i /><span>Smart Money Tracker</span></a>
      <nav className="appnav" aria-label="Apps">
        {APPS.map(([href, label]) => (
          <a key={href} href={href} className={href === active ? "on" : undefined} aria-current={href === active ? "page" : undefined}>{label}</a>
        ))}
      </nav>
      {right}
    </div></div>
  );
}
