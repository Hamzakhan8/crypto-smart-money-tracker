package com.smartmoney.engine.replay

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** SYNTHETIC DATA (unit test only): hand-built 1m candles with known barrier hits. */
class LabelerTest {
    private val t0 = 1_794_000_000_000L // a whole 5-minute boundary

    /** Minutes from [t0]: each spec is (open, high, low, close); volume 1, quote volume = close. Null = missing minute. */
    private fun minutes(vararg spec: DoubleArray?): Minutes {
        val rows = java.util.TreeMap<Long, DoubleArray>()
        spec.forEachIndexed { i, s -> if (s != null) rows[t0 + i * MINUTE] = doubleArrayOf(s[0], s[1], s[2], s[3], 1.0, s[3]) }
        return Minutes.fromRows("X", rows)
    }

    private fun flat(p: Double = 100.0) = doubleArrayOf(p, p + 0.1, p - 0.1, p)
    private fun flats(n: Int) = Array<DoubleArray?>(n) { flat() }

    @Test
    fun winWhenTheFavorableBarrierComesFirst() {
        val m = flats(40).also { it[5] = doubleArrayOf(100.0, 101.2, 99.9, 101.0) }
        val o = Labeler.label(m(*m), t0, dir = 1, width = 1.0, delay = Delay.D2M)
        assertEquals(Status.WIN, o.status)
        assertEquals(t0 + 2 * MINUTE, o.entryTime, "entry at the open of the minute 2 minutes after the signal")
        assertEquals(100.0, o.entryPrice)
        assertEquals(101.0, o.exitPrice)
        assertEquals(0.01, o.gross, 1e-12)
        assertEquals(t0 + 5 * MINUTE, o.exitMinute)
        assertEquals(3, o.minutesToPeak)
    }

    @Test
    fun lossWhenTheAdverseBarrierComesFirst() {
        val m = flats(40).also { it[4] = doubleArrayOf(100.0, 100.1, 98.8, 99.0); it[6] = doubleArrayOf(99.0, 102.0, 99.0, 101.0) }
        val o = Labeler.label(m(*m), t0, 1, 1.0, Delay.D2M)
        assertEquals(Status.LOSS, o.status)
        assertEquals(-0.01, o.gross, 1e-12)
        assertTrue(o.mae >= 0.012 - 1e-12)
    }

    @Test
    fun bothBarriersInOneCandleCountAsLossForEitherDirection() {
        val m = flats(40).also { it[3] = doubleArrayOf(100.0, 101.5, 98.5, 100.0) }
        for (dir in intArrayOf(1, -1)) {
            val o = Labeler.label(m(*m), t0, dir, 1.0, Delay.D2M)
            assertEquals(Status.LOSS, o.status, "dir $dir")
            assertTrue(o.ambiguous)
            assertEquals(-0.01, o.gross, 1e-12)
        }
    }

    @Test
    fun timeoutExitsAtTheLastClose() {
        val m = flats(40).also { it[31] = doubleArrayOf(100.0, 100.4, 99.9, 100.3) }
        val o = Labeler.label(m(*m), t0, 1, 1.0, Delay.D2M)
        assertEquals(Status.TIMEOUT, o.status)
        assertEquals(t0 + 31 * MINUTE, o.exitMinute, "30 minutes: entry minute 2 through minute 31")
        assertEquals(0.003, o.gross, 1e-12)
    }

    @Test
    fun shortWinsOnTheLowerBarrier() {
        val m = flats(40).also { it[10] = doubleArrayOf(100.0, 100.1, 98.9, 99.0) }
        val o = Labeler.label(m(*m), t0, -1, 1.0, Delay.D2M)
        assertEquals(Status.WIN, o.status)
        assertEquals(0.01, o.gross, 1e-12)
    }

    @Test
    fun aMissingMinuteInsideTheWindowIsInvalid() {
        val m = flats(40).also { it[20] = null }
        assertEquals(Status.INVALID, Labeler.label(m(*m), t0, 1, 1.0, Delay.D2M).status)
        // A gap after the 30-minute window does not matter.
        val later = flats(40).also { it[35] = null }
        assertEquals(Status.TIMEOUT, Labeler.label(m(*later), t0, 1, 1.0, Delay.D2M).status)
        // Not enough data after the signal.
        assertEquals(Status.INVALID, Labeler.label(m(*flats(20)), t0, 1, 1.0, Delay.D2M).status)
    }

    @Test
    fun entryNeverPrecedesTheSignalAndDelaysPickTheRightMinute() {
        val spec = Array<DoubleArray?>(45) { i -> doubleArrayOf(100.0 + i, 100.1 + i, 99.9 + i, 100.0 + i) }
        val m = m(*spec)
        val signal = t0 + 3 * MINUTE
        assertEquals(103.0, Labeler.label(m, signal, 1, 50.0, Delay.D0).entryPrice)
        assertEquals(105.0, Labeler.label(m, signal, 1, 50.0, Delay.D2M).entryPrice)
        assertEquals(108.0, Labeler.label(m, signal, 1, 50.0, Delay.D5M).entryPrice)
        val vwap = Labeler.label(m, signal, 1, 50.0, Delay.D30)
        assertEquals(103.0, vwap.entryPrice, "VWAP of the signal minute (quote volume / volume)")
        for (d in Delay.entries) assertTrue(Labeler.label(m, signal, 1, 50.0, d).entryTime >= signal, d.label)
    }

    @Test
    fun thirtySecondEntryIgnoresTheFillMinutesOwnRange() {
        // The fill minute itself spikes through the barrier; with a 30 s fill the order is unknown, so only later
        // minutes count.
        val m = flats(40).also { it[0] = doubleArrayOf(100.0, 102.0, 99.9, 100.0) }
        assertEquals(Status.TIMEOUT, Labeler.label(m(*m), t0, 1, 1.0, Delay.D30).status)
        assertEquals(Status.WIN, Labeler.label(m(*m), t0, 1, 1.0, Delay.D0).status)
    }

    @Test
    fun badWidthIsInvalid() {
        val m = m(*flats(40))
        assertEquals(Status.INVALID, Labeler.label(m, t0, 1, 0.0, Delay.D2M).status)
        assertEquals(Status.INVALID, Labeler.label(m, t0, 1, Double.NaN, Delay.D2M).status)
    }

    private fun m(vararg spec: DoubleArray?) = minutes(*spec)
}
