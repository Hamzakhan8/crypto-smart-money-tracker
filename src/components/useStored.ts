"use client";
import { useEffect, useState } from "react";

// A choice remembered in this browser (a tab, a filter). Storage can be blocked (private window): then it is just state.
export function useStored(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try { const v = localStorage.getItem(key); if (v != null) setValue(v); } catch { /* not available */ }
  }, [key]);
  const set = (v: string) => { setValue(v); try { localStorage.setItem(key, v); } catch { /* not available */ } };
  return [value, set];
}
