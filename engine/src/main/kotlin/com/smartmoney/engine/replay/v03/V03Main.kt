package com.smartmoney.engine.replay.v03

import com.smartmoney.engine.replay.Archive
import com.smartmoney.engine.replay.Interval
import com.smartmoney.engine.replay.OkHttpFetcher
import com.smartmoney.engine.replay.ReplayLab
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * v0.3 research command line (E006). From android/:  ./gradlew :engine:replayV03
 * Development stage only (train 2025, validation 2026Q1); the holdouts stay closed until the design freeze.
 */
fun main(args: Array<String>) {
    val opts = args.toList().chunked(2).filter { it.size == 2 }.associate { it[0].removePrefix("--") to it[1] }
    val repo = File(opts["repo"] ?: ".").canonicalFile
    val cache = File(opts["cache"] ?: File(repo, "engine/replay-cache").path)
    val command = opts["command"] ?: "./gradlew :engine:replayV03"
    val started = System.currentTimeMillis()
    fun log(s: String) = println("[${(System.currentTimeMillis() - started) / 1000}s] $s")

    val codeCommit = git(repo, "rev-parse", "HEAD")
    val dirty = git(repo, "status", "--porcelain", "--", "engine", "android", "docs/experiments.md").isNotBlank()
    val prereg = git(repo, "log", "-1", "--format=%H", "--", "docs/experiments.md")
    log("code $codeCommit${if (dirty) " (uncommitted changes!)" else ""}, pre-registration $prereg")

    val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS).build()
    val fetcher = OkHttpFetcher(client)
    val archive = Archive(cache, fetcher)
    val lab = ReplayLab(archive, fetcher, cache, ::log)
    val v03 = V03Lab(archive, lab, ::log)
    val ds = lab.dataSet()
    val recs = v03.build(ds, setOf(0, 1))
    log("${recs.count { it.period == 0 }} train and ${recs.count { it.period == 1 }} validation signals")
    val dev = v03.develop(recs)

    val manifest = archive.manifest
    val manifestText = buildJsonObject {
        put("description", "Every input file of the v0.3 development stage (train 2025, validation 2026Q1). Archive files checked against Binance's .CHECKSUM.")
        put("files", manifest.size)
        put("bytes", manifest.sumOf { it.bytes })
        put("entries", buildJsonArray { manifest.forEach { e -> add(buildJsonObject { put("path", e.path); put("sha256", e.sha256); put("bytes", e.bytes) }) } })
    }.toString().replace("},{", "},\n{") + "\n"
    val manifestFile = File(repo, "docs/v03-dataset-manifest.json").also { it.writeText(manifestText) }
    val manifestHash = Archive.sha256(manifestFile.readBytes())
    log("dataset manifest: ${manifest.size} files, sha256 $manifestHash")

    val out = File(repo, "docs/results").also { it.mkdirs() }
    val report = V03Report(dev, recs, command, codeCommit, dirty, prereg, manifestHash, manifest.size)
    File(out, "v03-development.md").writeText(report.markdown())
    File(out, "v03-development.json").writeText(report.json() + "\n")
    log("wrote docs/results/v03-development.md and .json")
}

internal fun git(repo: File, vararg args: String): String {
    val p = ProcessBuilder(listOf("git") + args).directory(repo).redirectErrorStream(true).start()
    val text = p.inputStream.bufferedReader().readText().trim()
    p.waitFor()
    return text
}

class V03Report(
    private val d: V03Lab.Dev,
    private val recs: List<Rec>,
    private val command: String,
    private val code: String,
    private val dirty: Boolean,
    private val prereg: String,
    private val manifest: String,
    private val files: Int,
) {
    private fun pct(x: Double?, digits: Int = 3) = if (x == null || x.isNaN() || x.isInfinite()) "n/a" else String.format(Locale.US, "%+.${digits}f%%", x * 100)
    private fun pct0(x: Double?) = if (x == null || x.isNaN()) "n/a" else String.format(Locale.US, "%.1f%%", x * 100)
    private fun num(x: Double, digits: Int = 2) = if (x.isNaN()) "n/a" else String.format(Locale.US, "%.${digits}f", x)
    private fun ci(i: Interval?) = if (i == null) "n/a" else "[${pct(i.lo)}, ${pct(i.hi)}]"
    private fun ciAdj(i: Interval?) = if (i == null) "n/a" else "[${pct(i.loAdj)}, ${pct(i.hiAdj)}]"
    private fun row(vararg c: Any?) = "| " + c.joinToString(" | ") { it?.toString() ?: "n/a" } + " |"
    private fun sep(n: Int) = row(*Array(n) { "---" })

    private fun perfCells(p: Perf) = arrayOf(p.trades, num(p.perDay, 1), pct0(p.winRate), pct(p.avgWin), pct(p.avgLoss), pct(p.expectancy?.mean), ci(p.expectancy), pct(p.lift?.mean), ci(p.lift))
    private val perfHead = arrayOf("Trades", "Per day", "Win rate", "Avg win", "Avg loss", "Expectancy", "95% CI", "Lift vs random", "95% CI")

    fun markdown(): String = buildString {
        appendLine("# v0.3 signal research: development stage (train 2025, validation 2026Q1)")
        appendLine()
        appendLine("Generated ${Instant.now()}. Pre-registered in docs/experiments.md E006. Binance USD-M perpetuals. Returns per \$1,000 trade after fees, spread, slippage and funding; expectancy = mean net per independent event; intervals by UTC-day blocks. **The holdouts (2026Q2, Jul-Oct 2026) are still closed.**")
        appendLine()
        appendLine("## Receipts")
        appendLine("- Command (from `android/`): `$command`")
        appendLine("- Code commit: `$code`${if (dirty) " **with uncommitted changes**" else " (clean)"}")
        appendLine("- Pre-registration commit: `$prereg`")
        appendLine("- Dataset manifest: `docs/v03-dataset-manifest.json`, sha256 `$manifest` ($files files)")
        appendLine("- Trial counter: ${V03Lab.TRIALS}")
        appendLine("- Signals: ${recs.count { it.period == 0 }} train, ${recs.count { it.period == 1 }} validation (rule C first signals)")
        appendLine()
        appendLine("## Base setup (v0.2 rule, market +2m, TP 1R / stop 1 ATR / 30 min)")
        appendLine(row("Period", *perfHead)); appendLine(sep(perfHead.size + 1))
        appendLine(row("train 2025", *perfCells(d.base)))
        appendLine(row("validation 2026Q1", *perfCells(d.baseVal)))
        appendLine()
        appendLine("## Stage 1: each confirmation alone on train (trials 9-27)")
        appendLine(row("Confirmation", "Passes", *perfHead, "Change vs base")); appendLine(sep(perfHead.size + 3))
        for (s in d.stage1) appendLine(row(CONFIRMATIONS[s.k], pct0(s.passShare), *perfCells(s.perf), pct((s.perf.expectancy?.mean ?: Double.NaN) - (d.base.expectancy?.mean ?: Double.NaN))))
        appendLine()
        appendLine("## Correlation groups (|phi| of pass flags on train >= 0.4)")
        for (g in d.groups) appendLine("- " + g.joinToString(", ") { CONFIRMATIONS[it] })
        val pairs = d.phi.indices.flatMap { a -> (a + 1 until d.phi.size).map { b -> Triple(a, b, d.phi[a][b]) } }.sortedByDescending { kotlin.math.abs(it.third) }.take(10)
        appendLine()
        appendLine("Strongest correlations: " + pairs.joinToString("; ") { "${CONFIRMATIONS[it.first].substringBefore(' ')} - ${CONFIRMATIONS[it.second].substringBefore(' ')} ${num(it.third)}" })
        appendLine()
        appendLine("Group winners that beat the base on train (expectancy and lift > 0), in Stage 2 order: " +
            (if (d.winners.isEmpty()) "**none**" else d.winners.joinToString(", ") { CONFIRMATIONS[it] }))
        appendLine()
        appendLine("## Stage 2: forward selection judged on validation (top-10% score rule)")
        if (d.stage2.isEmpty()) appendLine("No candidate entered Stage 2.")
        else {
            appendLine(row("Candidate", "Decision", *perfHead)); appendLine(sep(perfHead.size + 2))
            for (s in d.stage2) appendLine(row(CONFIRMATIONS[s.k], s.reason, *perfCells(s.perf)))
        }
        appendLine()
        if (d.model == null) {
            appendLine("## Result: no confirmation survived Stage 2")
            appendLine()
            appendLine("Per E006, the answer is **no edge found** on the development data; the holdouts are not needed, and the v0.2 rule stays EXPERIMENTAL.")
            return@buildString
        }
        appendLine("## Score")
        appendLine("Kept: " + d.kept.joinToString(", ") { CONFIRMATIONS[it] } + ". Logistic coefficients (standardized): intercept ${num(d.model.beta[0])}, " +
            d.kept.mapIndexed { i, k -> "${CONFIRMATIONS[k].substringBefore(' ')} ${num(d.model.beta[i + 1])}" }.joinToString(", ") + ". Shown when score >= 90.")
        appendLine()
        appendLine("## Stage 3: exits on validation (market +2m)")
        appendLine(row("Exit", *perfHead, "Breakeven win rate", "Max drawdown")); appendLine(sep(perfHead.size + 3))
        for ((e, p) in d.exits) appendLine(row(EXITS[e].label + if (e == d.bestExit) " (best)" else "", *perfCells(p), pct0(p.breakevenWinRate), pct(-p.maxDrawdown)))
        appendLine()
        appendLine("Entries with the best exit:")
        appendLine(row("Entry", *perfHead)); appendLine(sep(perfHead.size + 1))
        for ((en, p) in d.entries) appendLine(row(en.label, *perfCells(p)))
        appendLine()
        appendLine("Chosen: **${d.finalEntry.label}, ${EXITS[d.bestExit].label}**.")
        appendLine()
        appendLine("## Ablation on validation (final entry and exit)")
        appendLine(row("Removed", "Trades with all", "Expectancy with all", "Trades without", "Expectancy without", "Change")); appendLine(sep(6))
        for ((k, all, wo) in d.ablation) appendLine(row(CONFIRMATIONS[k], all.trades, pct(all.expectancy?.mean), wo.trades, pct(wo.expectancy?.mean), pct((all.expectancy?.mean ?: 0.0) - (wo.expectancy?.mean ?: 0.0))))
        appendLine()
        appendLine("## Final rule before the holdouts")
        appendLine(row("Period", *perfHead, "Max drawdown")); appendLine(sep(perfHead.size + 2))
        d.finalTrain?.let { appendLine(row("train 2025 (in-sample)", *perfCells(it), pct(-it.maxDrawdown))) }
        d.finalVal?.let { appendLine(row("validation 2026Q1", *perfCells(it), pct(-it.maxDrawdown))) }
        val perDay = d.finalVal?.perDay ?: 0.0
        if (perDay < 1.0) appendLine("\n**Too sparse:** ${num(perDay, 2)} signals per day on validation (E006 flags fewer than 1 per day).")
        appendLine()
        val v = VarRes.v(d.finalEntry, d.bestExit)
        val sel = d.valSelected
        appendLine("Validation breakdown: long ${sel.count { it.sig.moveDir > 0 }} / short ${sel.count { it.sig.moveDir < 0 }} signals; " +
            "mean net long ${pct(sel.filter { it.sig.moveDir > 0 }.mapNotNull { it.own.net(v) }.average())}, short ${pct(sel.filter { it.sig.moveDir < 0 }.mapNotNull { it.own.net(v) }.average())}.")
        val byCoin = sel.mapNotNull { r -> r.own.net(v)?.let { r.sig.symbol to it } }.groupBy({ it.first }, { it.second }).mapValues { it.value.sum() }
        val total = byCoin.values.sum()
        val top5 = byCoin.entries.sortedByDescending { it.value }.take(5)
        appendLine("Top 5 coins by summed net: " + top5.joinToString(", ") { "${it.key} ${pct(it.value, 2)}" } + "; all coins ${pct(total, 2)}.")
        appendLine()
        appendLine("Development results only. PROVEN requires the pre-registered holdout checks (E006).")
    }

    fun json(): String = buildJsonObject {
        put("code", code); put("dirty", dirty); put("prereg", prereg); put("manifestSha256", manifest); put("trials", V03Lab.TRIALS)
        put("kept", buildJsonArray { d.kept.forEach { add(kotlinx.serialization.json.JsonPrimitive(CONFIRMATIONS[it])) } })
        put("finalEntry", d.finalEntry.label); put("finalExit", EXITS[d.bestExit].label)
        put("validationExpectancy", d.finalVal?.expectancy?.mean ?: Double.NaN)
        put("validationTrades", d.finalVal?.trades ?: 0)
        put("baseValidationExpectancy", d.baseVal.expectancy?.mean ?: Double.NaN)
        put("generated", Instant.now().atZone(ZoneOffset.UTC).toString())
    }.toString()
}
