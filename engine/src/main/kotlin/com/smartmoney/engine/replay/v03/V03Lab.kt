package com.smartmoney.engine.replay.v03

import com.smartmoney.engine.features.Features
import com.smartmoney.engine.replay.Archive
import com.smartmoney.engine.replay.Bootstrap
import com.smartmoney.engine.replay.CostModel
import com.smartmoney.engine.replay.DAY
import com.smartmoney.engine.replay.Event
import com.smartmoney.engine.replay.Events
import com.smartmoney.engine.replay.FIVE_MIN
import com.smartmoney.engine.replay.Interval
import com.smartmoney.engine.replay.Minutes
import com.smartmoney.engine.replay.Regime
import com.smartmoney.engine.replay.ReplayLab
import com.smartmoney.engine.replay.Sig
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneOffset
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Outcomes of one signal or random entry for every entry x exit variant (v = entry.ordinal * EXITS.size + exit). */
class VarRes {
    val fill = arrayOfNulls<Fill>(V)
    val gross = DoubleArray(V) { Double.NaN }
    val cost = DoubleArray(V) { Double.NaN }
    val hedged = DoubleArray(V) { Double.NaN }

    /** Net return with costs scaled by [costMult]; null when not traded or no cost estimate. */
    fun net(v: Int, costMult: Double = 1.0, useHedged: Boolean = false): Double? {
        val f = fill[v] ?: return null
        if (f != Fill.WIN && f != Fill.LOSS && f != Fill.TIMEOUT) return null
        val g = if (useHedged) hedged[v] else gross[v]
        if (g.isNaN() || cost[v].isNaN()) return null
        return g - costMult * cost[v]
    }

    companion object {
        val V = Entry.entries.size * EXITS.size
        fun v(entry: Entry, exit: Int) = entry.ordinal * EXITS.size + exit
        val BASE = v(Entry.M2, 0)
    }
}

/** One base signal (first of its event) with its features and outcomes, and its matched random entries' outcomes. */
class Rec(val sig: Sig, val period: Int, val f: FeatureRow, val own: VarRes, val rnd: List<VarRes>)

/** Summary of a selection under one variant (per independent event, E1; intervals by day blocks, S1). */
class Perf(
    val trades: Int,
    val days: Double,
    val winRate: Double,
    val avgWin: Double,
    val avgLoss: Double,
    val expectancy: Interval?,
    val lift: Interval?,
    val maxDrawdown: Double,
) {
    val perDay: Double get() = if (days > 0) trades / days else 0.0
    val breakevenWinRate: Double get() = if (avgWin.isNaN() || avgLoss.isNaN() || avgWin - avgLoss == 0.0) Double.NaN else -avgLoss / (avgWin - avgLoss)
}

/**
 * v0.3 research (E006). The development stage uses train (2025) and validation (2026Q1) only; holdout A (2026Q2) and
 * holdout B (Jul-Oct 2026) are evaluated by [holdout] after the design freeze.
 */
class V03Lab(private val archive: Archive, private val lab: ReplayLab, private val log: (String) -> Unit, private val threads: Int = 4) {
    companion object {
        const val TRIALS = 48
        const val SHOW_SCORE = 90.0
        val TRAIN_START: Long = ReplayLab.start(YearMonth.of(2025, 1))
        val VAL_START: Long = ReplayLab.start(YearMonth.of(2026, 1))
        val HOLD_A_START: Long = ReplayLab.start(YearMonth.of(2026, 4))
        val HOLD_B_START: Long = ReplayLab.start(YearMonth.of(2026, 7))
        val HOLD_B_END: Long = ReplayLab.start(YearMonth.of(2026, 11))
        val PERIOD_NAMES = listOf("train 2025", "validation 2026Q1", "holdout A 2026Q2", "holdout B Jul-Oct 2026")
        val PERIOD_BOUNDS = listOf(TRAIN_START to VAL_START, VAL_START to HOLD_A_START, HOLD_A_START to HOLD_B_START, HOLD_B_START to HOLD_B_END)
        fun periodOf(t: Long): Int = PERIOD_BOUNDS.indexOfFirst { (a, b) -> t - FIVE_MIN >= a && t - FIVE_MIN < b }
    }

    private fun <T> parallel(items: List<T>, n: Int, f: (T) -> Unit) {
        val pool = Executors.newFixedThreadPool(n)
        try {
            items.map { pool.submit(Callable { f(it) }) }.forEach {
                try { it.get() } catch (e: java.util.concurrent.ExecutionException) { throw e.cause ?: e }
            }
        } finally {
            pool.shutdown()
        }
    }

    private fun metricsDays(ds: ReplayLab.DataSet, sym: String, until: Long): List<java.time.LocalDate> =
        ds.needed[sym].orEmpty().flatMap { ym -> (1..ym.lengthOfMonth()).map { ym.atDay(it) } }
            .filter { it.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() < until }

    /**
     * Builds the records of the periods in [periods] from the data set [ds]: base rule C first signals with features,
     * every variant's outcome, and the 5 matched random entries (same seeds as Phase 3).
     */
    fun build(ds: ReplayLab.DataSet, periods: Set<Int>): List<Rec> {
        val from = periods.minOf { PERIOD_BOUNDS[it].first }
        val until = periods.maxOf { PERIOD_BOUNDS[it].second }
        val memberMonths = HashMap<String, MutableSet<YearMonth>>()
        val rankOf = HashMap<Pair<String, YearMonth>, Int>()
        for ((ym, syms) in ds.universe) syms.forEachIndexed { i, s -> memberMonths.getOrPut(s) { HashSet() } += ym; rankOf[s to ym] = i + 1 }

        log("metrics archive (open interest, long/short ratio) for the needed days")
        val metricFiles = ConcurrentHashMap<String, List<java.io.File>>()
        parallel(ds.needed.keys.sorted(), 12) { sym ->
            metricFiles[sym] = metricsDays(ds, sym, until).mapNotNull { day ->
                archive.get("${ReplayLab.UM}/daily/metrics/$sym/$sym-metrics-$day.zip")
            }
        }
        log("  ${metricFiles.values.sumOf { it.size }} metrics files")

        val eth = Minutes.load("ETHUSDT", ds.oneMinute["ETHUSDT"].orEmpty())
        val ethClose = eth.bars5m().associate { it.openTime to it.close }
        val out = java.util.Collections.synchronizedList(ArrayList<Rec>())
        log("features and ${VarRes.V} entry x exit variants per signal (${ds.needed.size} symbols)")
        parallel(ds.needed.keys.sorted(), threads) { sym ->
            val m = if (sym == "BTCUSDT") ds.btc else Minutes.load(sym, ds.oneMinute.getValue(sym))
            val bars = if (sym == "BTCUSDT") ds.btcBars else m.bars5m()
            val ctx = ReplayLab.SymbolCtx(sym, m, bars, ds.costs, ds.btc, ds.btcClose, from, until)
            val all = lab.detect(ctx, memberMonths[sym].orEmpty(), rankOf, from, until).getValue(ReplayLab.RULE_C)
            val first = Events.firstSignals(all).filter { periodOf(it.t) in periods }
            if (first.isEmpty()) return@parallel
            val busy = all.map { it.t }.toLongArray().also { it.sort() }
            val calc = FeatureCalc(sym, m, bars, ctx.barIndex, ds.btcClose, ethClose, FeatureCalc.metricsFrom(metricFiles[sym].orEmpty())) { t -> ds.costs.lastFunding(sym, t) }
            for (s in first) {
                val i = ctx.barIndex[s.t - FIVE_MIN] ?: continue
                val rs = ctx.randomTimes(s.t, busy, java.util.Random(ReplayLab.SEED xor s.t xor ReplayLab.RULE_C.hashCode().toLong() xor (sym.hashCode().toLong() shl 20)))
                out += Rec(s, periodOf(s.t), calc.compute(i, s.moveDir), simulate(ctx, ds.costs, i, s.t, s.moveDir), rs.asList().mapNotNull { rt ->
                    ctx.barIndex[rt - FIVE_MIN]?.let { ri -> simulate(ctx, ds.costs, ri, rt, s.moveDir) }
                })
            }
        }
        return out.sortedWith(compareBy({ it.sig.t }, { it.sig.symbol }))
    }

    private fun simulate(ctx: ReplayLab.SymbolCtx, costs: CostModel, i: Int, t: Long, d: Int): VarRes {
        val r = VarRes()
        val atrPct = Features.atrPct(ctx.bars, i) ?: return r
        val atr = atrPct * ctx.bars[i - 1].close
        val beta = ctx.beta(i)
        for (entry in Entry.entries) for (e in EXITS.indices) {
            val v = VarRes.v(entry, e)
            val o = Sim.run(ctx.m, ctx.bars, ctx.barIndex, i, d, atr, entry, EXITS[e])
            r.fill[v] = o.fill
            if (!o.traded) continue
            r.gross[v] = o.gross
            r.cost[v] = costs.trade(ctx.sym, d, 1_000.0, t, o.entryPrice, o.exitPrice, o.entryTime, o.exitMinute + 60_000L, o.maker)?.total ?: Double.NaN
            if (beta != null) {
                val bIn = ctx.btc.idx(o.entryTime - Math.floorMod(o.entryTime, 60_000L)).takeIf { it >= 0 }?.let { ctx.btc.o[it] }
                val bOut = ctx.btc.idx(o.exitMinute).takeIf { it >= 0 }?.let { ctx.btc.c[it] }
                if (bIn != null && bOut != null && bIn > 0) r.hedged[v] = o.gross - d * beta * (bOut / bIn - 1)
            }
        }
        return r
    }

    // --------------------------------------------------------------------------------------------------------------
    // Evaluation

    fun perf(sel: List<Rec>, v: Int, periodDays: Double, costMult: Double = 1.0, hedged: Boolean = false): Perf {
        val byKey = sel.associateBy { it.sig }
        val events = Events.group(sel.map { it.sig })
        val exp = ArrayList<Pair<Long, Double>>()
        val lift = ArrayList<Pair<Long, Double>>()
        for (e in events) {
            val vals = ArrayList<Double>()
            val lifts = ArrayList<Double>()
            for (s in e.members) {
                val r = byKey.getValue(s)
                val n = r.own.net(v, costMult, hedged) ?: continue
                vals += n
                val rn = r.rnd.mapNotNull { it.net(v, costMult, hedged) }
                if (rn.isNotEmpty()) lifts += n - rn.average()
            }
            if (vals.isNotEmpty()) exp += e.day to vals.average()
            if (lifts.isNotEmpty()) lift += e.day to lifts.average()
        }
        val traded = sel.mapNotNull { r -> r.own.net(v, costMult, hedged)?.let { r to it } }
        val wins = traded.count { it.first.own.fill[v] == Fill.WIN }
        val pos = traded.map { it.second }.filter { it > 0 }
        val neg = traded.map { it.second }.filter { it <= 0 }
        var peak = 0.0; var cum = 0.0; var dd = 0.0
        for ((_, n) in traded.sortedBy { it.first.sig.t }) { cum += n; peak = maxOf(peak, cum); dd = maxOf(dd, peak - cum) }
        return Perf(
            trades = traded.size, days = periodDays,
            winRate = if (traded.isEmpty()) Double.NaN else wins.toDouble() / traded.size,
            avgWin = if (pos.isEmpty()) Double.NaN else pos.average(), avgLoss = if (neg.isEmpty()) Double.NaN else neg.average(),
            expectancy = Bootstrap.dayBlock(exp, TRIALS), lift = Bootstrap.dayBlock(lift, TRIALS), maxDrawdown = dd,
        )
    }

    private fun mean(p: Perf) = p.expectancy?.mean ?: Double.NEGATIVE_INFINITY
    private fun liftMean(p: Perf) = p.lift?.mean ?: Double.NEGATIVE_INFINITY

    fun fitModel(train: List<Rec>, features: List<Int>): ScoreModel {
        val rows = train.filter { it.own.net(VarRes.BASE) != null }
        return ScoreModel.fit(features, rows.map { it.f.x }, rows.map { it.own.fill[VarRes.BASE] == Fill.WIN })
    }

    fun select(recs: List<Rec>, model: ScoreModel, threshold: Double = SHOW_SCORE) = recs.filter { model.score(it.f.x) >= threshold }

    class StageOne(val k: Int, val perf: Perf, val passShare: Double)
    class StageTwo(val k: Int, val kept: Boolean, val perf: Perf, val reason: String)
    class Dev(
        val base: Perf, val baseVal: Perf, val stage1: List<StageOne>, val groups: List<List<Int>>, val phi: Array<DoubleArray>,
        val winners: List<Int>, val stage2: List<StageTwo>, val kept: List<Int>, val model: ScoreModel?,
        val exits: List<Pair<Int, Perf>>, val bestExit: Int, val entries: List<Pair<Entry, Perf>>, val finalEntry: Entry,
        val finalVal: Perf?, val finalTrain: Perf?, val ablation: List<Triple<Int, Perf, Perf>>, val valSelected: List<Rec>,
    )

    /** Stages 1-3 and the ablation, exactly as pre-registered in E006. */
    fun develop(recs: List<Rec>): Dev {
        val train = recs.filter { it.period == 0 }
        val valid = recs.filter { it.period == 1 }
        val trainDays = (VAL_START - TRAIN_START) / DAY.toDouble()
        val valDays = (HOLD_A_START - VAL_START) / DAY.toDouble()
        val base = perf(train, VarRes.BASE, trainDays)
        val baseVal = perf(valid, VarRes.BASE, valDays)

        log("stage 1: ${CONFIRMATIONS.size} confirmations alone on train")
        val stage1 = CONFIRMATIONS.indices.map { k ->
            val sel = train.filter { it.f.pass[k] }
            StageOne(k, perf(sel, VarRes.BASE, trainDays), sel.size.toDouble() / train.size)
        }

        val n = CONFIRMATIONS.size
        val phi = Array(n) { a -> DoubleArray(n) { b -> ScoreModel.phi(BooleanArray(train.size) { train[it].f.pass[a] }, BooleanArray(train.size) { train[it].f.pass[b] }) } }
        val parent = IntArray(n) { it }
        fun find(a: Int): Int { var x = a; while (parent[x] != x) x = parent[x]; return x }
        for (a in 0 until n) for (b in a + 1 until n) if (kotlin.math.abs(phi[a][b]) >= 0.4) parent[find(a)] = find(b)
        val groups = (0 until n).groupBy { find(it) }.values.map { it.sorted() }.sortedBy { it.first() }
        val winners = groups.map { g -> g.maxBy { mean(stage1[it].perf) } }
            .filter { mean(stage1[it].perf) > mean(base) && liftMean(stage1[it].perf) > 0 }
            .sortedByDescending { mean(stage1[it].perf) }

        log("stage 2: forward selection on validation (${winners.size} candidates)")
        val kept = ArrayList<Int>()
        var current = mean(baseVal)
        val stage2 = ArrayList<StageTwo>()
        for (c in winners.take(8)) {
            if (kept.size >= 5) break
            val model = fitModel(train, kept + c)
            val p = perf(select(valid, model), VarRes.BASE, valDays)
            val ok = mean(p) > current && liftMean(p) > 0
            stage2 += StageTwo(c, ok, p, if (ok) "kept" else if (mean(p) <= current) "validation expectancy did not improve" else "validation lift not above random")
            if (ok) { kept += c; current = mean(p) }
        }
        if (kept.isEmpty()) {
            return Dev(base, baseVal, stage1, groups, phi, winners, stage2, kept, null, emptyList(), 0, emptyList(), Entry.M2, null, null, emptyList(), emptyList())
        }

        log("stage 3: exits and entries on validation")
        val model = fitModel(train, kept)
        val valSel = select(valid, model)
        val exits = EXITS.indices.map { e -> e to perf(valSel, VarRes.v(Entry.M2, e), valDays) }
        val bestExit = exits.maxBy { mean(it.second) }.first
        var finalEntry = Entry.M2
        var bestP = exits.first { it.first == bestExit }.second
        val entries = listOf(Entry.FT, Entry.LIM).map { en -> en to perf(valSel, VarRes.v(en, bestExit), valDays) }
        for ((en, p) in entries) if (mean(p) > mean(bestP)) { finalEntry = en; bestP = p }
        val fv = VarRes.v(finalEntry, bestExit)
        val ablation = kept.map { k ->
            val without = kept - k
            val p = if (without.isEmpty()) perf(valid, fv, valDays) else perf(select(valid, fitModel(train, without)), fv, valDays)
            Triple(k, bestP, p)
        }
        return Dev(base, baseVal, stage1, groups, phi, winners, stage2, kept, model, exits, bestExit, entries, finalEntry, bestP,
            perf(select(train, model), fv, trainDays), ablation, valSel)
    }
}
