// Loads KEY=VALUE lines from the .env file next to this file into process.env, so `node server.js` works without
// `--env-file` (which needs Node 20.6+). Values already set in the shell win. A missing .env is fine.
// Imported first by server.js and screener.js, before any module reads its settings.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
let text = "";
try { text = readFileSync(file, "utf8"); } catch { /* no .env */ }
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  let value = m[2];
  if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1); // quoted: keep as is
  else value = value.replace(/\s+#.*$/, "");                  // unquoted: drop a trailing comment
  if (process.env[m[1]] === undefined) process.env[m[1]] = value;
}
