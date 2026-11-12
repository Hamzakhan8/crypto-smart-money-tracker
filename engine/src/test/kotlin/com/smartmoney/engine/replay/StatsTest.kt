package com.smartmoney.engine.replay

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** SYNTHETIC DATA (unit test only): bootstrap, events, regime. */
class StatsTest {
    private val d0 = 1_735_689_600_000L // 2025-01-01 00:00 UTC

    @Test
    fun bootstrapIsDeterministicAndCentered() {
        val rng = java.util.Random(1)
        val values = (0 until 300).map { (d0 + (it % 60) * DAY) to (0.001 + rng.nextGaussian() * 0.01) }
        val a = Bootstrap.dayBlock(values, trials = 4)!!
        val b = Bootstrap.dayBlock(values, trials = 4)!!
        assertEquals(a, b, "same seed, same interval")
        assertEquals(values.map { it.second }.average(), a.mean, 1e-15)
        assertTrue(a.lo < a.mean && a.mean < a.hi)
        assertTrue(a.loAdj <= a.lo && a.hiAdj >= a.hi, "the Bonferroni interval is wider")
        assertEquals(60, a.days)
        val c = Bootstrap.dayBlock(List(50) { (d0 + it * DAY) to 0.002 }, 1)!!
        assertEquals(0.002, c.lo, 1e-15)
        assertEquals(0.002, c.hi, 1e-15)
        assertNull(Bootstrap.dayBlock(emptyList(), 1))
    }

    private fun sig(sym: String, minute: Long, dir: Int = 1) = Sig("A", sym, d0 + minute * MINUTE, dir, 0.03 * dir, null, 1)

    @Test
    fun signalsWithinAnHourOfTheFirstAreOneEvent() {
        val first = Events.firstSignals(listOf(sig("X", 0), sig("X", 30), sig("X", 60), sig("X", 61), sig("X", 70, -1), sig("Y", 30)))
        // X at 0 (60 is still within the hour of 0), X at 61 starts a new event, the down move is separate, Y separate.
        assertEquals(listOf("X" to 0L, "Y" to 30L, "X" to 61L, "X" to 70L), first.map { it.symbol to (it.t - d0) / MINUTE })
    }

    @Test
    fun fiveSymbolsInOneQuarterHourAreOneMarketEvent() {
        val many = listOf("A", "B", "C", "D", "E").mapIndexed { i, s -> sig(s, i.toLong()) }
        val events = Events.group(many + sig("F", 20))
        assertEquals(2, events.size)
        assertTrue(events.first().market)
        assertEquals(5, events.first().members.size)
        val four = Events.group(listOf("A", "B", "C", "D").map { sig(it, 1) })
        assertEquals(4, four.size)
        assertTrue(four.none { it.market })
    }

    @Test
    fun regimeUsesOnlyEarlierData() {
        val hours = 24 * 200
        val rng = java.util.Random(3)
        var p = 40_000.0
        val open = LongArray(hours) { d0 + it * HOUR }
        val close = DoubleArray(hours) { p *= 1 + rng.nextGaussian() * 0.004; p }
        val full = Regime(open, close, d0 + 7 * DAY)
        val day = d0 + 150 * DAY
        val cut = (150 * 24)
        val truncated = Regime(open.copyOf(cut), close.copyOf(cut), d0 + 7 * DAY)
        assertNotNull(full.cell(day))
        assertEquals(full.cell(day), truncated.cell(day), "adding later prices must not change a past day's regime")
        assertEquals(full.metrics(day), truncated.metrics(day))
        assertNull(full.cell(d0 + 20 * DAY), "fewer than 60 earlier days: unknown")
    }
}
