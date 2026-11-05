// Loads KEY=VALUE lines from the .env file next to this file into process.env, so the app works without
// `--env-file` (which needs Node 20.6+). Values already set in the shell win. A missing .env is fine.
// Imported first by server.ts and screener.ts, before any module reads its settings.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
let text = "";
try {
  const buf = readFileSync(file);
  text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8"); // Notepad's "Unicode" = UTF-16
  text = text.replace(/^\uFEFF/, "");
} catch { /* no .env */ }
const preset = new Set(Object.keys(process.env)); // set in the shell: those win over .env
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  let value = m[2];
  const q = value.match(/^(["'“”])(.*)(["'“”])(?:\s+#.*)?$/);
  if (q) value = q[2];                                         // quoted (a comment after the quotes is dropped)
  else value = value.replace(/\s+#.*$/, "");                  // unquoted: drop a trailing comment
  if (!preset.has(m[1])) process.env[m[1]] = value;            // a key repeated in .env: the last line wins
}
