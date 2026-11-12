package com.smartmoney.engine.replay

import kotlin.math.ln
import kotlin.math.sqrt

/** Mean with a day-block bootstrap interval (S1) and its Bonferroni-adjusted version. */
data class Interval(
    val n: Int,
    val days: Int,
    val mean: Double,
    val lo: Double,
    val hi: Double,
    val loAdj: Double,
    val hiAdj: Double,
    val trials: Int,
) {
    val containsZero: Boolean get() = lo <= 0.0 && hi >= 0.0
}

object Bootstrap {
    const val B = 2000
    const val SEED = 20261112L

    /**
     * [values] = (UTC day start, value) per independent event. Resamples whole days with replacement [b] times.
     * Adjusted interval: two-sided level 1 - 0.05 / [trials].
     */
    fun dayBlock(values: List<Pair<Long, Double>>, trials: Int, b: Int = B, seed: Long = SEED): Interval? {
        val clean = values.filter { it.second.isFinite() }
        if (clean.isEmpty()) return null
        val byDay = clean.groupBy({ it.first }, { it.second }).toSortedMap().values.toList()
        val sums = DoubleArray(byDay.size) { byDay[it].sum() }
        val counts = IntArray(byDay.size) { byDay[it].size }
        val rng = java.util.Random(seed)
        val means = DoubleArray(b)
        for (r in 0 until b) {
            var s = 0.0
            var n = 0
            for (k in byDay.indices) {
                val d = rng.nextInt(byDay.size)
                s += sums[d]
                n += counts[d]
            }
            means[r] = s / n
        }
        means.sort()
        val alpha = 0.05 / trials.coerceAtLeast(1)
        return Interval(
            n = clean.size, days = byDay.size, mean = clean.sumOf { it.second } / clean.size,
            lo = quantile(means, 0.025), hi = quantile(means, 0.975),
            loAdj = quantile(means, alpha / 2), hiAdj = quantile(means, 1 - alpha / 2), trials = trials,
        )
    }

    fun quantile(sorted: DoubleArray, q: Double): Double {
        if (sorted.isEmpty()) return Double.NaN
        val pos = q * (sorted.size - 1)
        val i = pos.toInt().coerceIn(0, sorted.size - 1)
        val j = (i + 1).coerceAtMost(sorted.size - 1)
        return sorted[i] + (sorted[j] - sorted[i]) * (pos - i)
    }
}

/**
 * Regime G1: per UTC day, BTC's 7-day return (r7) and the standard deviation of its hourly log returns over 7 days (v7),
 * both from hourly closes up to the start of that day. Tercile cut points come only from earlier days' values.
 */
class Regime(hourOpen: LongArray, hourClose: DoubleArray, private val firstDay: Long) {
    data class Day(val r7: Double, val v7: Double)

    private val days = java.util.TreeMap<Long, Day>()

    init {
        val closeAt = HashMap<Long, Double>(hourOpen.size * 2)
        for (i in hourOpen.indices) closeAt[hourOpen[i] + HOUR] = hourClose[i] // close known at the hour's end
        val start = firstDay
        val end = (hourOpen.lastOrNull() ?: 0L) + HOUR
        var d = start
        while (d <= end) {
            val now = closeAt[d]
            val weekAgo = closeAt[d - 7 * DAY]
            if (now != null && weekAgo != null) {
                val rets = ArrayList<Double>(168)
                for (k in 0 until 168) {
                    val a = closeAt[d - (k + 1) * HOUR]
                    val b = closeAt[d - k * HOUR]
                    if (a != null && b != null && a > 0 && b > 0) rets += ln(b / a)
                }
                if (rets.size >= 150) {
                    val m = rets.average()
                    days[d] = Day(now / weekAgo - 1, sqrt(rets.sumOf { (it - m) * (it - m) } / (rets.size - 1)))
                }
            }
            d += DAY
        }
    }

    fun metrics(dayStart: Long): Day? = days[dayStart]

    private val cells = HashMap<Long, Int?>()

    /** Regime cell 0..8 = r7 tercile x 3 + v7 tercile, using cut points from days before [dayStart]; null if unknown. */
    @Synchronized
    fun cell(dayStart: Long): Int? = cells.getOrPut(dayStart) {
        val today = days[dayStart] ?: return@getOrPut null
        val past = days.headMap(dayStart, false).values
        if (past.size < 60) return@getOrPut null
        val r = past.map { it.r7 }.sorted()
        val v = past.map { it.v7 }.sorted()
        tercile(today.r7, r) * 3 + tercile(today.v7, v)
    }

    companion object {
        val R7 = listOf("BTC 7d down", "BTC 7d flat", "BTC 7d up")
        val V7 = listOf("calm", "normal vol", "volatile")
        fun cellName(c: Int) = "${R7[c / 3]}, ${V7[c % 3]}"

        fun tercile(x: Double, sorted: List<Double>): Int {
            val a = Bootstrap.quantile(sorted.toDoubleArray(), 1.0 / 3)
            val b = Bootstrap.quantile(sorted.toDoubleArray(), 2.0 / 3)
            return when {
                x <= a -> 0
                x <= b -> 1
                else -> 2
            }
        }
    }
}

/** A signal found by a rule at bar close [t] (pre-registration B1). */
data class Sig(
    val rule: String,
    val symbol: String,
    val t: Long,
    val moveDir: Int,
    val move: Double,
    val z: Double?,
    /** Volume rank of the symbol in that month's universe (1 = most traded). */
    val rank: Int,
)

/** Independent event (E1): one symbol's first signal, or a market-wide cluster of first signals. */
data class Event(val members: List<Sig>, val market: Boolean) {
    val t: Long get() = members.minOf { it.t }
    val day: Long get() = t - Math.floorMod(t, DAY)
}

object Events {
    const val SAME_EVENT_MS = 60 * MINUTE
    const val MARKET_BUCKET_MS = 15 * MINUTE
    const val MARKET_MIN_SYMBOLS = 5

    /**
     * E1 step 1: per symbol and move direction, a signal within 60 minutes after the event's first signal belongs to
     * that event; only first signals are traded.
     */
    fun firstSignals(signals: List<Sig>): List<Sig> {
        val out = ArrayList<Sig>()
        val anchor = HashMap<Pair<String, Int>, Long>()
        for (s in signals.sortedWith(compareBy({ it.t }, { it.symbol }))) {
            val k = s.symbol to s.moveDir
            val a = anchor[k]
            if (a == null || s.t - a > SAME_EVENT_MS) {
                anchor[k] = s.t
                out += s
            }
        }
        return out
    }

    /** E1 step 2: first signals of 5+ symbols in one 15-minute bucket form one market-wide event. */
    fun group(first: List<Sig>): List<Event> {
        val out = ArrayList<Event>()
        for ((_, inBucket) in first.groupBy { it.t - Math.floorMod(it.t, MARKET_BUCKET_MS) }.toSortedMap()) {
            if (inBucket.map { it.symbol }.distinct().size >= MARKET_MIN_SYMBOLS) out += Event(inBucket, market = true)
            else inBucket.forEach { out += Event(listOf(it), market = false) }
        }
        return out
    }
}
