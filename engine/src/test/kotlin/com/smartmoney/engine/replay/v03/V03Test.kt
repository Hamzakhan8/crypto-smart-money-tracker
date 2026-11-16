package com.smartmoney.engine.replay.v03

import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.replay.FIVE_MIN
import com.smartmoney.engine.replay.MINUTE
import com.smartmoney.engine.replay.Minutes
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** SYNTHETIC DATA (unit test only): v0.3 indicators, trade simulation, score and as-of features. */
class V03Test {
    private val t0 = 1_794_000_000_000L

    @Test
    fun emaRsiBollinger() {
        val x = DoubleArray(10) { (it + 1).toDouble() }
        val e = Indicators.ema(x, 3)
        assertTrue(e[1].isNaN())
        assertEquals(2.0, e[2], 1e-12) // seed = mean(1, 2, 3)
        assertEquals(0.5 * 4 + 0.5 * 2.0, e[3], 1e-12)
        val up = Indicators.rsi(DoubleArray(30) { it.toDouble() })
        assertEquals(100.0, up[29], 1e-9)
        val flat = Indicators.bollingerWidth(DoubleArray(30) { 5.0 })
        assertEquals(0.0, flat[29], 1e-12)
        assertEquals(0.5, Indicators.percentile(DoubleArray(40) { it.toDouble() }, 0, 40, 19.5), 1e-12)
    }

    /** Minutes from t0: (open, high, low, close); volume 1. */
    private fun minutes(vararg spec: DoubleArray): Minutes {
        val rows = java.util.TreeMap<Long, DoubleArray>()
        spec.forEachIndexed { i, s -> rows[t0 + i * MINUTE] = doubleArrayOf(s[0], s[1], s[2], s[3], 1.0, s[3], s[3] / 2) }
        return Minutes.fromRows("X", rows)
    }

    private fun flat(p: Double = 100.0) = doubleArrayOf(p, p + 0.05, p - 0.05, p)

    /** One 5m signal bar opening at t0 - 5m (so t = t0), and the next bar at t0. */
    private fun bars(signal: Candle, next: Candle? = null) = listOfNotNull(signal, next)
    private val signalBar = Candle(t0 - FIVE_MIN, 98.0, 100.2, 97.8, 100.0, 1.0, 1.0, closed = true)

    private fun run(m: Minutes, entry: Entry, exit: Exit, d: Int = 1, next: Candle? = null): SimOut {
        val bs = bars(signalBar, next)
        val idx = bs.withIndex().associate { it.value.openTime to it.index }
        return Sim.run(m, bs, idx, 0, d, atr = 1.0, entry = entry, exit = exit)
    }

    @Test
    fun takeProfitAtTwoR() {
        val spec = Array(140) { flat() }.also { it[10] = doubleArrayOf(100.0, 102.1, 99.9, 102.0) }
        val o = run(minutes(*spec), Entry.M2, EXITS[6]) // TP 2R, 30 min
        assertEquals(Fill.WIN, o.fill)
        assertEquals(0.02, o.gross, 1e-12)
    }

    @Test
    fun stopAndTargetInOneCandleIsAStop() {
        val spec = Array(140) { flat() }.also { it[5] = doubleArrayOf(100.0, 103.0, 98.9, 100.0) }
        val o = run(minutes(*spec), Entry.M2, EXITS[3])
        assertEquals(Fill.LOSS, o.fill)
        assertEquals(-0.01, o.gross, 1e-12)
    }

    @Test
    fun partialBooksHalfThenBreakeven() {
        val spec = Array(140) { flat() }.also {
            it[5] = doubleArrayOf(100.0, 101.05, 99.95, 101.0) // 1R hit: half booked, stop to entry
            it[8] = doubleArrayOf(100.5, 100.6, 99.9, 100.0) // back to entry: second half at 0
        }
        val o = run(minutes(*spec), Entry.M2, EXITS[10])
        assertEquals(Fill.WIN, o.fill)
        assertEquals(0.5 * 0.01, o.gross, 1e-12)
    }

    @Test
    fun limitPullbackFillsAtTheMidpointOrNotAtAll() {
        // Signal bar midpoint = (100.2 + 97.8) / 2 = 99.0.
        val filled = Array(140) { flat() }.also { it[6] = doubleArrayOf(99.5, 99.6, 98.9, 99.2) }
        val o = run(minutes(*filled), Entry.LIM, EXITS[0])
        assertTrue(o.maker)
        assertEquals(99.0, o.entryPrice, 1e-12)
        assertEquals(t0 + 6 * MINUTE, o.entryTime)
        assertEquals(Fill.NOFILL, run(minutes(*Array(140) { flat() }), Entry.LIM, EXITS[0]).fill)
        // In the fill minute only the stop counts: a drop through the stop right after the fill is a loss.
        val crash = Array(140) { flat() }.also { it[6] = doubleArrayOf(99.5, 99.6, 97.5, 98.0) }
        assertEquals(Fill.LOSS, run(minutes(*crash), Entry.LIM, EXITS[0]).fill)
    }

    @Test
    fun followThroughNeedsTheNextBarToConfirm() {
        val m = minutes(*Array(140) { flat() })
        val up = Candle(t0, 100.0, 100.5, 99.9, 100.4, 1.0, 1.0, closed = true)
        val down = Candle(t0, 100.0, 100.1, 99.5, 99.6, 1.0, 1.0, closed = true)
        val confirmed = run(m, Entry.FT, EXITS[0], next = up)
        assertEquals(t0 + FIVE_MIN + 2 * MINUTE, confirmed.entryTime)
        assertEquals(Fill.NOFILL, run(m, Entry.FT, EXITS[0], next = down).fill)
    }

    @Test
    fun structureStopIsClampedToHalfAndTwoAtr() {
        // Entry 100, signal low 97.8 -> 2.2 below, clamped to 2 ATR; target 1.5 x 2 = 3.
        val spec = Array(140) { flat() }.also { it[20] = doubleArrayOf(100.0, 103.1, 99.9, 103.0) }
        val o = run(minutes(*spec), Entry.M2, EXITS[9])
        assertEquals(Fill.WIN, o.fill)
        assertEquals(103.0, o.exitPrice, 1e-12)
    }

    @Test
    fun scoreLearnsTheInformativeFeature() {
        val rng = java.util.Random(5)
        val xs = List(2000) { DoubleArray(19) { Double.NaN }.also { a -> a[3] = rng.nextGaussian(); a[7] = rng.nextGaussian() } }
        val y = xs.map { it[3] + 0.3 * rng.nextGaussian() > 0 }
        val m = ScoreModel.fit(listOf(3, 7), xs, y)
        assertTrue(m.beta[1] > 1.0, "feature C4 drives the outcome")
        assertTrue(kotlin.math.abs(m.beta[2]) < 0.3, "feature C8 is noise")
        val high = DoubleArray(19) { Double.NaN }.also { it[3] = 2.0; it[7] = 0.0 }
        val low = DoubleArray(19) { Double.NaN }.also { it[3] = -2.0; it[7] = 0.0 }
        assertTrue(m.score(high) > 95 && m.score(low) < 5)
        val unknown = DoubleArray(19) { Double.NaN }
        assertTrue(m.score(unknown) in 30.0..70.0, "unknown values sit at the train mean")
    }

    @Test
    fun featuresUseOnlyDataUpToTheSignal() {
        val n = 3000
        val rng = java.util.Random(9)
        var p = 100.0
        val bars = ArrayList<Candle>()
        val rows = java.util.TreeMap<Long, DoubleArray>()
        for (i in 0 until n) {
            val open = t0 + i * FIVE_MIN
            val o = p
            p *= 1 + rng.nextGaussian() * 0.003
            bars += Candle(open, o, maxOf(o, p) * 1.001, minOf(o, p) * 0.999, p, 10.0, 1000.0 * (1 + rng.nextDouble()), closed = true)
            for (k in 0 until 5) rows[open + k * MINUTE] = doubleArrayOf(o, maxOf(o, p), minOf(o, p), p, 2.0, 200.0, 100.0 + rng.nextDouble() * 20)
        }
        val m = Minutes.fromRows("X", rows)
        fun calc(bs: List<Candle>) = FeatureCalc("X", m, bs, bs.withIndex().associate { it.value.openTime to it.index }, emptyMap(), emptyMap(), null) { null }
        val i = 2500
        val full = calc(bars).compute(i, 1)
        val cut = calc(bars.subList(0, i + 1)).compute(i, 1)
        assertTrue(full.pass.contentEquals(cut.pass), "pass flags must not change when later bars exist")
        for (k in full.x.indices) assertTrue(full.x[k].isNaN() && cut.x[k].isNaN() || kotlin.math.abs(full.x[k] - cut.x[k]) < 1e-12, CONFIRMATIONS[k])
    }

    @Test
    fun metricsAreUsedOnlyWhenFresh() {
        val s = MetricsSeries(longArrayOf(t0, t0 + 5 * MINUTE), doubleArrayOf(1.0, 2.0), doubleArrayOf(1.0, 1.0))
        assertEquals(1, s.asOf(t0 + 6 * MINUTE))
        assertEquals(-1, s.asOf(t0 + 20 * MINUTE), "older than 10 minutes: unknown")
        assertEquals(-1, s.asOf(t0 - MINUTE))
    }
}
