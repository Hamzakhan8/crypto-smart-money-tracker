// The app: one Next.js + TypeScript server, one process, one port.
//   - every /api route and every scanner come from the engine (server.js);
//   - every page is React (src/app): / (Market Flow), /screener (all its tabs) and /ai (the AI desk).
//
//   npm run build, then npm start   production
//   npm run dev                      development (live reload)
// The classic HTML pages are still there as a fallback: npm run start:classic (node server.js), or /screener-classic.
import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import next from "next";
import { createHandler, startServices, listenOn, onListenError } from "./server.js";

const dev = !process.argv.includes("--prod") && process.env.NODE_ENV !== "production";
// Pages the React app serves instead of the classic HTML pages.
const REACT_PAGES = new Set(["/", "/ai", "/screener"]);

if (!dev && !existsSync(path.join(import.meta.dirname, ".next", "BUILD_ID"))) {
  console.error("The web pages are not built yet: run `npm run build` once (about a minute), then `npm start` again.");
  process.exit(1);
}
const app = next({ dev, dir: import.meta.dirname, hostname: listenOn.HOST, port: listenOn.PORT, ...(dev ? { turbopack: true } : {}) });
const nextHandle = app.getRequestHandler();
await app.prepare();

const server = http.createServer(createHandler({ fallback: (req, res) => nextHandle(req, res), skip: REACT_PAGES }));
if (dev) server.on("upgrade", app.getUpgradeHandler()); // live reload
server.on("error", onListenError);
server.listen(listenOn.PORT, listenOn.HOST, () => {
  console.log(`Next.js ${dev ? "development" : "production"} server (React pages: ${[...REACT_PAGES].join(", ")}; classic fallback: /screener-classic)`);
  startServices();
});
