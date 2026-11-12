package com.smartmoney.engine.replay

import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale
import kotlin.math.abs

enum class Hyp(val label: String, val sign: Int) { CONTINUE("CONTINUE", 1), REVERT("REVERT", -1) }

/** Event-level evaluation of the prepared labels (pre-registration E1, R1, S1, P1). */
class Analysis(private val p: Prepared, val trials: Int) {
    val sizes = listOf(1_000.0, 10_000.0)

    /** Net (or BTC-hedged net) return of one labeled time, or null if invalid / no cost estimate / no hedge. */
    fun net(symbol: String, t: Long, dir: Int, delay: Delay, size: Double, hedged: Boolean): Double? {
        val r = p.results[ReplayLab.key(symbol, t)] ?: return null
        val s = KeyResult.slot(delay, dir)
        val st = r.status[s] ?: return null
        if (st == Status.INVALID) return null
        val c = if (size <= 1_000.0) r.cost1k[s] else r.cost10k[s]
        val g = if (hedged) r.hedged[s] else r.gross[s]
        if (c.isNaN() || g.isNaN()) return null
        return g - c
    }

    class Member(val value: Double?, val randoms: List<Double>) {
        val randMean: Double? get() = if (randoms.isEmpty()) null else randoms.average()
        val lift: Double? get() = value?.let { v -> randMean?.let { v - it } }
    }

    fun members(set: TradeSet, hyp: Hyp, delay: Delay, size: Double, hedged: Boolean): Map<Sig, Member> = set.first.associateWith { s ->
        val dir = hyp.sign * s.moveDir
        Member(
            net(s.symbol, s.t, dir, delay, size, hedged),
            set.randoms[s]?.asList()?.mapNotNull { net(s.symbol, it, dir, delay, size, hedged) }.orEmpty(),
        )
    }

    class EventValue(val event: Event, val net: Double?, val lift: Double?)

    fun eventValues(set: TradeSet, members: Map<Sig, Member>): List<EventValue> = set.events.map { e ->
        val ms = e.members.mapNotNull { members[it] }
        val nets = ms.mapNotNull { it.value }
        val lifts = ms.mapNotNull { it.lift }
        EventValue(e, if (nets.isEmpty()) null else nets.average(), if (lifts.isEmpty()) null else lifts.average())
    }

    class Summary(val lift: Interval?, val net: Interval?, val events: Int)

    fun summarize(values: List<EventValue>, filter: (Event) -> Boolean = { true }): Summary {
        val v = values.filter { filter(it.event) }
        return Summary(
            Bootstrap.dayBlock(v.mapNotNull { e -> e.lift?.let { e.event.day to it } }, trials),
            Bootstrap.dayBlock(v.mapNotNull { e -> e.net?.let { e.event.day to it } }, trials),
            v.size,
        )
    }

    fun summary(set: TradeSet, hyp: Hyp, delay: Delay = Delay.D2M, size: Double = 1_000.0, hedged: Boolean = false, filter: (Event) -> Boolean = { true }) =
        summarize(eventValues(set, members(set, hyp, delay, size, hedged)), filter)

    /** SPEC verdict for a baseline at 2 min, $1,000. */
    fun verdict(raw: Summary, hedged: Summary): String {
        val n = raw.lift?.n ?: 0
        if (n < 100) return "INCONCLUSIVE"
        val rl = raw.lift ?: return "INCONCLUSIVE"
        val hl = hedged.lift ?: return "INCONCLUSIVE"
        return if (rl.loAdj > 0 && hl.loAdj > 0) "LIFT" else "NO LIFT"
    }

    /** P1 shuffled labels: within each day, outcomes permuted between real signals and their matched randoms. */
    fun shuffledLift(set: TradeSet, seed: Long = Bootstrap.SEED): Interval? {
        val ms = members(set, Hyp.CONTINUE, Delay.D2M, 1_000.0, hedged = false)
        val rng = java.util.Random(seed)
        val shuffled = HashMap<Sig, Member>()
        for ((_, sigs) in set.first.groupBy { it.t - Math.floorMod(it.t, DAY) }.toSortedMap()) {
            val pool = ArrayList<Double>()
            for (s in sigs) {
                val m = ms.getValue(s)
                m.value?.let { pool += it }
                pool += m.randoms
            }
            pool.shuffle(rng)
            var k = 0
            for (s in sigs) {
                val m = ms.getValue(s)
                val v = if (m.value != null) pool[k++] else null
                val rs = m.randoms.map { pool[k++] }
                shuffled[s] = Member(v, rs)
            }
        }
        val values = eventValues(set, shuffled)
        return Bootstrap.dayBlock(values.mapNotNull { e -> e.lift?.let { e.event.day to it } }, trials)
    }

    class OutcomeStats(val n: Int, val win: Int, val loss: Int, val timeout: Int, val ambiguous: Int, val invalid: Int, val noCost: Int, val noHedge: Int, val noRandom: Int, val mfe: Double, val mae: Double, val medianToPeak: Double)

    fun outcomes(set: TradeSet, hyp: Hyp, delay: Delay = Delay.D2M): OutcomeStats {
        var win = 0; var loss = 0; var timeout = 0; var amb = 0; var invalid = 0; var noCost = 0; var noHedge = 0; var noRandom = 0
        val mfe = ArrayList<Double>()
        val mae = ArrayList<Double>()
        val peak = ArrayList<Double>()
        for (s in set.first) {
            val r = p.results[ReplayLab.key(s.symbol, s.t)]
            val slot = KeyResult.slot(delay, hyp.sign * s.moveDir)
            val st = r?.status?.get(slot)
            if (r == null || st == null || st == Status.INVALID) { invalid++; continue }
            when (st) {
                Status.WIN -> win++
                Status.LOSS -> loss++
                Status.TIMEOUT -> timeout++
                else -> Unit
            }
            if (r.ambiguous[slot]) amb++
            if (r.cost1k[slot].isNaN()) noCost++
            if (r.hedged[slot].isNaN()) noHedge++
            if (set.randoms[s]?.isEmpty() != false) noRandom++
            mfe += r.mfe[slot]; mae += r.mae[slot]; peak += r.toPeak[slot].toDouble()
        }
        return OutcomeStats(set.first.size, win, loss, timeout, amb, invalid, noCost, noHedge, noRandom,
            if (mfe.isEmpty()) Double.NaN else mfe.average(), if (mae.isEmpty()) Double.NaN else mae.average(),
            if (peak.isEmpty()) Double.NaN else CostModel.median(peak))
    }

    class Budget(val k: Int, val n: Int, val days: Int, val winRate: Double, val meanNet: Double)

    /** E004: per day, the top K first signals by |move|; win rate and mean net (CONTINUE, 2 min, $1,000). */
    fun budget(set: TradeSet, k: Int): Budget {
        val picked = ArrayList<Pair<Boolean, Double>>()
        var days = 0
        for ((_, sigs) in set.first.groupBy { it.t - Math.floorMod(it.t, DAY) }) {
            val valid = sigs.mapNotNull { s ->
                val dir = s.moveDir
                val v = net(s.symbol, s.t, dir, Delay.D2M, 1_000.0, false) ?: return@mapNotNull null
                val st = p.results[ReplayLab.key(s.symbol, s.t)]?.status?.get(KeyResult.slot(Delay.D2M, dir))
                Triple(s, st == Status.WIN, v)
            }.sortedByDescending { abs(it.first.move) }.take(k)
            if (valid.isNotEmpty()) days++
            valid.forEach { picked += it.second to it.third }
        }
        return Budget(k, picked.size, days, if (picked.isEmpty()) Double.NaN else picked.count { it.first }.toDouble() / picked.size,
            if (picked.isEmpty()) Double.NaN else picked.map { it.second }.average())
    }

    // Breakdown keys
    fun quarter(e: Event): String {
        val d = Instant.ofEpochMilli(e.day).atZone(ZoneOffset.UTC)
        return "${d.year}Q${(d.monthValue - 1) / 3 + 1}"
    }

    fun regimeOf(e: Event): String = p.regime.cell(e.day)?.let { Regime.cellName(it) } ?: "unknown (no history)"
    fun tierOf(e: Event): String = if (e.market) "market-wide event" else if (e.members.first().rank <= 10) "volume rank 1-10" else "volume rank 11+"
    fun directionOf(e: Event): String = if (e.market) "market-wide event" else if (e.members.first().moveDir > 0) "after an up move" else "after a down move"

    companion object {
        fun pct(x: Double?, digits: Int = 3): String = if (x == null || x.isNaN()) "n/a" else String.format(Locale.US, "%+.${digits}f%%", x * 100)
        fun ci(i: Interval?, adjusted: Boolean = false): String = if (i == null) "n/a" else if (adjusted) "[${pct(i.loAdj)}, ${pct(i.hiAdj)}]" else "[${pct(i.lo)}, ${pct(i.hi)}]"
    }
}
