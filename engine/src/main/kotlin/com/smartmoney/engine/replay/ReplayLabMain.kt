package com.smartmoney.engine.replay

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.io.File
import java.time.Instant
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Replay Lab command line (Phase 3). From android/:  ./gradlew :engine:replayLab
 * Downloads (or reuses) the verified archive data, runs every pre-registered baseline and placebo of
 * docs/experiments.md, and writes docs/replay-dataset-manifest.json and docs/results/phase3-baselines.{md,json}.
 */
fun main(args: Array<String>) {
    val opts = args.toList().chunked(2).filter { it.size == 2 }.associate { it[0].removePrefix("--") to it[1] }
    val repo = File(opts["repo"] ?: ".").canonicalFile
    val cache = File(opts["cache"] ?: File(repo, "engine/replay-cache").path)
    val command = opts["command"] ?: "./gradlew :engine:replayLab"
    val started = System.currentTimeMillis()
    fun log(s: String) = println("[${(System.currentTimeMillis() - started) / 1000}s] $s")

    // Receipts first: code and pre-registration commits as they are before this run writes anything.
    val codeCommit = git(repo, "rev-parse", "HEAD")
    val dirty = git(repo, "status", "--porcelain", "--", "engine", "android", "docs/experiments.md").isNotBlank()
    val prereg = git(repo, "log", "-1", "--format=%H", "--", "docs/experiments.md")
    val trials = Regex("Trial counter: (\\d+)").find(File(repo, "docs/experiments.md").readText())?.groupValues?.get(1)?.toInt()
        ?: error("trial counter not found in docs/experiments.md")
    log("code $codeCommit${if (dirty) " (uncommitted changes!)" else ""}, pre-registration $prereg, trials $trials")

    val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS).build()
    val fetcher = OkHttpFetcher(client)
    val archive = Archive(cache, fetcher)
    val prepared = ReplayLab(archive, fetcher, cache, ::log).prepare()

    val manifest = archive.manifest
    val manifestJson = buildJsonObject {
        put("description", "Every input file of the Phase 3 replay. Archive files were checked against Binance's published .CHECKSUM (sha256).")
        put("files", manifest.size)
        put("bytes", manifest.sumOf { it.bytes })
        put("entries", buildJsonArray {
            manifest.forEach { e -> add(buildJsonObject { put("path", e.path); put("sha256", e.sha256); put("bytes", e.bytes); put("source", e.source) }) }
        })
    }.toString().replace("},{", "},\n{") + "\n"
    val manifestFile = File(repo, "docs/replay-dataset-manifest.json")
    manifestFile.writeText(manifestJson)
    val manifestHash = Archive.sha256(manifestFile.readBytes())
    log("dataset manifest: ${manifest.size} files, ${manifest.sumOf { it.bytes } / 1_000_000} MB, sha256 $manifestHash")

    val receipts = Receipts(command, codeCommit, dirty, prereg, manifestHash, manifest.size, manifest.sumOf { it.bytes }, trials)
    val analysis = Analysis(prepared, trials)
    val report = Report(prepared, analysis, receipts)
    val out = File(repo, "docs/results").also { it.mkdirs() }
    File(out, "phase3-baselines.md").writeText(report.markdown())
    File(out, "phase3-baselines.json").writeText(report.json().toString() + "\n")
    log("wrote docs/results/phase3-baselines.md and .json")
}

private fun git(repo: File, vararg args: String): String {
    val p = ProcessBuilder(listOf("git") + args).directory(repo).redirectErrorStream(true).start()
    val text = p.inputStream.bufferedReader().readText().trim()
    p.waitFor()
    return text
}

class Receipts(
    val command: String,
    val codeCommit: String,
    val dirty: Boolean,
    val preregCommit: String,
    val manifestSha256: String,
    val files: Int,
    val bytes: Long,
    val trials: Int,
)

/** Markdown and JSON report; every number carries its event count, and the header carries the receipts. */
class Report(private val p: Prepared, private val a: Analysis, private val r: Receipts) {
    private val ruleNames = mapOf(
        ReplayLab.RULE_A to "Baseline A: naive scanner (5m move >= 2%)",
        ReplayLab.RULE_C to "Baseline C: app's Track A Confirmed rule (move >= 2 ATR + gates)",
    )
    private val trialNo = mapOf((ReplayLab.RULE_A to Hyp.CONTINUE) to 1, (ReplayLab.RULE_A to Hyp.REVERT) to 2, (ReplayLab.RULE_C to Hyp.CONTINUE) to 3, (ReplayLab.RULE_C to Hyp.REVERT) to 4)

    private fun fmt(x: Double) = String.format(Locale.US, "%.1f", x)
    private fun pct(x: Double?) = Analysis.pct(x)
    private fun row(vararg cells: Any?) = "| " + cells.joinToString(" | ") { it?.toString() ?: "n/a" } + " |"

    private fun statCells(s: Analysis.Summary): List<String> = listOf(
        "${s.lift?.n ?: 0}", pct(s.net?.mean), pct(s.lift?.mean), Analysis.ci(s.lift), Analysis.ci(s.lift, adjusted = true),
    )

    fun markdown(): String = buildString {
        val delisted = p.universe.values.flatten().distinct().count { p.status[it] != "TRADING" }
        val symbols = p.universe.values.flatten().distinct().size
        appendLine("# Phase 3 Replay Lab: baseline results")
        appendLine()
        appendLine("Generated ${Instant.now()} by the Replay Lab. Pre-registered in docs/experiments.md (shared definitions v1, E001-E004).")
        appendLine("Returns are per trade as a % of the trade size. Lift = net return of the signal minus the mean net return of 5 random")
        appendLine("entries on the same coin and day (same direction, delay, costs). Statistics are per independent event.")
        appendLine()
        appendLine("## Receipts")
        appendLine()
        appendLine("- Command (from `android/`): `${r.command}`")
        appendLine("- Code commit: `${r.codeCommit}`${if (r.dirty) " **with uncommitted changes**" else " (clean)"}")
        appendLine("- Pre-registration commit: `${r.preregCommit}`")
        appendLine("- Dataset manifest: `docs/replay-dataset-manifest.json`, sha256 `${r.manifestSha256}` (${r.files} files, ${r.bytes / 1_000_000} MB, every archive file checked against Binance's .CHECKSUM)")
        appendLine("- Trial counter: ${r.trials}; adjusted intervals use the two-sided level 1 - 0.05/${r.trials} (Bonferroni)")
        appendLine("- Bootstrap: UTC-day blocks, B = ${Bootstrap.B}, seed ${Bootstrap.SEED}")
        appendLine("- Data: Binance USD-M perpetuals, development period ${ReplayLab.DEV_START} to ${ReplayLab.DEV_END} (holdout 2026-07 to 2026-10 not used); $symbols symbols were in the monthly top-${ReplayLab.TOP} universe, $delisted of them are no longer trading today (delisted or settling); ${p.minutesLoaded} 1m candles, ${p.barsBuilt} 5m bars")
        appendLine()

        appendLine("## Results per trial (2-minute entry delay, \$1,000 trade)")
        appendLine()
        appendLine(row("Trial", "Rule", "Trade", "Events", "Mean net", "Mean lift", "95% CI", "Adjusted CI", "Hedged lift", "Hedged adj. CI", "Verdict"))
        appendLine(row("---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"))
        for (rule in ReplayLab.RULES) for (hyp in Hyp.entries) {
            val set = p.real.getValue(rule)
            val raw = a.summary(set, hyp)
            val hedged = a.summary(set, hyp, hedged = true)
            appendLine(row(trialNo[rule to hyp], rule, hyp.label, raw.lift?.n ?: 0, pct(raw.net?.mean), pct(raw.lift?.mean), Analysis.ci(raw.lift), Analysis.ci(raw.lift, true), pct(hedged.lift?.mean), Analysis.ci(hedged.lift, true), "**${a.verdict(raw, hedged)}**"))
        }
        appendLine()
        appendLine("Verdict rule (E001/E002): fewer than 100 events = INCONCLUSIVE; LIFT only if the adjusted lower bound is above 0 for both raw and BTC-hedged lift; otherwise NO LIFT.")
        appendLine()

        for (rule in ReplayLab.RULES) {
            val set = p.real.getValue(rule)
            appendLine("## ${ruleNames[rule]}")
            appendLine()
            appendLine("Signals: ${p.allSignals.getValue(rule).size} raw, ${set.first.size} traded (first of each event), ${set.events.size} independent events (${set.events.count { it.market }} market-wide).")
            appendLine()
            for (hyp in Hyp.entries) {
                appendLine("### ${hyp.label} (trial ${trialNo[rule to hyp]})")
                appendLine()
                val o = a.outcomes(set, hyp)
                val valid = (o.n - o.invalid).coerceAtLeast(1)
                appendLine("Outcomes at 2 min (traded signals, n = ${o.n}): win ${o.win} (${fmt(100.0 * o.win / valid)}%), loss ${o.loss} (${fmt(100.0 * o.loss / valid)}%, of which ${o.ambiguous} ambiguous: both barriers in one candle), timeout ${o.timeout} (${fmt(100.0 * o.timeout / valid)}%), invalid ${o.invalid} (data gap). No cost estimate: ${o.noCost}; no hedge: ${o.noHedge}; no random match: ${o.noRandom}. Mean max favorable move ${pct(o.mfe)}, mean max adverse move ${pct(o.mae)}, median minutes to the best price ${fmt(o.medianToPeak)}.")
                appendLine()
                appendLine(row("Delay", "Size", "Events", "Mean net", "Mean lift", "95% CI", "Adjusted CI"))
                appendLine(row("---", "---", "---", "---", "---", "---", "---"))
                for (d in Delay.entries) for (size in a.sizes) {
                    appendLine(row(d.label, "\$${size.toInt()}", *statCells(a.summary(set, hyp, d, size)).toTypedArray()))
                }
                appendLine()
                val values = a.eventValues(set, a.members(set, hyp, Delay.D2M, 1_000.0, false))
                for ((title, keyOf) in listOf<Pair<String, (Event) -> String>>("Walk-forward fold (quarter)" to a::quarter, "BTC regime" to a::regimeOf, "Symbol tier" to a::tierOf, "Move direction" to a::directionOf)) {
                    appendLine(row(title, "Events", "Mean net", "Mean lift", "95% CI"))
                    appendLine(row("---", "---", "---", "---", "---"))
                    for (k in values.map { keyOf(it.event) }.distinct().sorted()) {
                        val s = a.summarize(values) { keyOf(it) == k }
                        appendLine(row(k, s.lift?.n ?: 0, pct(s.net?.mean), pct(s.lift?.mean), Analysis.ci(s.lift)))
                    }
                    appendLine()
                }
            }
        }

        appendLine("## Placebo tests (E003; CONTINUE, 2 min, \$1,000; pass = 95% CI contains 0)")
        appendLine()
        appendLine(row("Rule", "Placebo", "Judged on", "Events", "Mean lift", "95% CI", "Pass"))
        appendLine(row("---", "---", "---", "---", "---", "---", "---"))
        for (rule in ReplayLab.RULES) {
            val shift = a.summary(p.shift.getValue(rule), Hyp.CONTINUE).lift
            val shuffle = a.shuffledLift(p.real.getValue(rule))
            val swapH = a.summary(p.symbolSwap.getValue(rule), Hyp.CONTINUE, hedged = true).lift
            val swapR = a.summary(p.symbolSwap.getValue(rule), Hyp.CONTINUE).lift
            appendLine(row(rule, "time shift", "raw net lift", shift?.n ?: 0, pct(shift?.mean), Analysis.ci(shift), pass(shift)))
            appendLine(row(rule, "shuffled labels", "raw net lift", shuffle?.n ?: 0, pct(shuffle?.mean), Analysis.ci(shuffle), pass(shuffle)))
            appendLine(row(rule, "random symbol", "BTC-hedged net lift", swapH?.n ?: 0, pct(swapH?.mean), Analysis.ci(swapH), pass(swapH)))
            appendLine(row(rule, "random symbol", "raw net lift (reported only)", swapR?.n ?: 0, pct(swapR?.mean), Analysis.ci(swapR), "-"))
        }
        appendLine()

        appendLine("## Precision at an alert budget (E004; ranked by plain % move; CONTINUE, 2 min, \$1,000)")
        appendLine()
        appendLine(row("Rule", "Top K per day", "Signals", "Days", "Win rate", "Mean net"))
        appendLine(row("---", "---", "---", "---", "---", "---"))
        for (rule in ReplayLab.RULES) for (k in listOf(5, 10, 20)) {
            val b = a.budget(p.real.getValue(rule), k)
            appendLine(row(rule, k, b.n, b.days, if (b.winRate.isNaN()) "n/a" else "${fmt(100 * b.winRate)}%", pct(b.meanNet)))
        }
        appendLine()
        appendLine("Not validated, descriptive only. No probability or accuracy claim follows from these tables.")
    }

    private fun pass(i: Interval?): String = when {
        i == null -> "n/a"
        i.containsZero -> "yes"
        else -> "**NO**"
    }

    fun json(): JsonObject = buildJsonObject {
        put("receipts", buildJsonObject {
            put("command", r.command); put("codeCommit", r.codeCommit); put("dirty", r.dirty); put("preregCommit", r.preregCommit)
            put("manifestSha256", r.manifestSha256); put("files", r.files); put("bytes", r.bytes); put("trials", r.trials)
        })
        put("trials", buildJsonArray {
            for (rule in ReplayLab.RULES) for (hyp in Hyp.entries) {
                val set = p.real.getValue(rule)
                add(buildJsonObject {
                    put("trial", trialNo[rule to hyp]); put("rule", rule); put("hypothesis", hyp.label)
                    val raw = a.summary(set, hyp)
                    val hedged = a.summary(set, hyp, hedged = true)
                    put("verdict", a.verdict(raw, hedged))
                    put("raw", interval(raw.lift)); put("hedged", interval(hedged.lift)); put("net", interval(raw.net))
                    put("byDelaySize", buildJsonArray {
                        for (d in Delay.entries) for (size in a.sizes) {
                            val s = a.summary(set, hyp, d, size)
                            add(buildJsonObject { put("delay", d.label); put("size", size); put("lift", interval(s.lift)); put("net", interval(s.net)) })
                        }
                    })
                })
            }
        })
        put("placebos", buildJsonArray {
            for (rule in ReplayLab.RULES) {
                add(buildJsonObject { put("rule", rule); put("placebo", "time shift"); put("lift", interval(a.summary(p.shift.getValue(rule), Hyp.CONTINUE).lift)) })
                add(buildJsonObject { put("rule", rule); put("placebo", "shuffled labels"); put("lift", interval(a.shuffledLift(p.real.getValue(rule)))) })
                add(buildJsonObject { put("rule", rule); put("placebo", "random symbol (hedged)"); put("lift", interval(a.summary(p.symbolSwap.getValue(rule), Hyp.CONTINUE, hedged = true).lift)) })
            }
        })
    }

    private fun interval(i: Interval?): JsonObject = if (i == null) JsonObject(emptyMap()) else buildJsonObject {
        put("events", i.n); put("days", i.days); put("mean", i.mean); put("lo", i.lo); put("hi", i.hi); put("loAdj", i.loAdj); put("hiAdj", i.hiAdj)
    }
}
