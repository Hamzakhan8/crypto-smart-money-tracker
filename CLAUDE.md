# Smart Money Tracker

A crypto research dashboard: the engine (scanners and every `/api` route) is plain Node.js in the repo root
(`server.js`, `screener.js` and one module per part); the pages are Next.js + TypeScript in `src/`
(`next-server.ts` runs both on one port). The README explains every part, its tests and settings.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.
It is built from the code on this PC (no API cost) and rebuilt by the git hooks after every commit, checkout, merge
and rebase; it is not committed to git.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts (exact names like `createWhaleSignals` give the sharpest answers). These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- If graphify-out/ is missing (a fresh clone or worktree before its first hook run), run `graphify update .` once, or work without it.
