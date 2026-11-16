package com.smartmoney.screener

import com.smartmoney.engine.model.Candle
import com.smartmoney.screener.data.HitEntity
import com.smartmoney.screener.data.Paper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SYNTHETIC DATA (unit test only): live paper scoring of v0.3 signals. */
class PaperTest {
    private val tf = 5 * 60_000L
    private val close = 1_794_000_000_000L // signal candle closed here
    private fun c(k: Int, h: Double, l: Double, cl: Double, closed: Boolean = true) = Candle(close + k * tf, 100.0, h, l, cl, 1.0, 1.0, closed = closed)
    private val costs = 0.0012

    @Test
    fun targetFirstIsAWin() {
        val r = Paper.evaluate(listOf(c(0, 100.5, 99.8, 100.2), c(1, 101.2, 100.1, 101.0)), tf, close, 100.0, 101.0, 99.0, 1, costs, close + 60 * 60_000L)!!
        assertEquals("WIN", r.status)
        assertEquals(0.01 - costs, r.net, 1e-12)
    }

    @Test
    fun stopAndTargetInOneCandleIsALoss() {
        val r = Paper.evaluate(listOf(c(0, 101.5, 98.5, 100.0)), tf, close, 100.0, 101.0, 99.0, 1, costs, close + 60 * 60_000L)!!
        assertEquals("LOSS", r.status)
        assertEquals(-0.01 - costs, r.net, 1e-12)
    }

    @Test
    fun shortsWinBelow() {
        val r = Paper.evaluate(listOf(c(2, 100.2, 98.9, 99.0)), tf, close, 100.0, 99.0, 101.0, -1, costs, close + 60 * 60_000L)!!
        assertEquals("WIN", r.status)
    }

    @Test
    fun timeoutOnlyAfterThirtyMinutesOfCandles() {
        val six = (0 until 6).map { c(it, 100.3, 99.7, 100.1) }
        val r = Paper.evaluate(six, tf, close, 100.0, 101.0, 99.0, 1, costs, close + 31 * 60_000L)!!
        assertEquals("TIMEOUT", r.status)
        assertEquals(0.001 - costs, r.net, 1e-12)
        assertNull("still inside the 30 minutes", Paper.evaluate(six.take(3), tf, close, 100.0, 101.0, 99.0, 1, costs, close + 16 * 60_000L))
        assertNull("candles not loaded yet", Paper.evaluate(emptyList(), tf, close, 100.0, 101.0, 99.0, 1, costs, close + 40 * 60_000L))
    }

    @Test
    fun summaryAndDecayFlag() {
        fun hit(status: String, net: Double) = HitEntity(
            candleOpenTime = 0, loggedAt = 0, exchange = "BINANCE", market = "PERP", canonical = "X/USDT", nativeSymbol = "XUSDT",
            timeframe = "5m", tier = "CONFIRMED", label = "LONG", direction = "UP", price = 1.0, move = null, zMove = null,
            relVolume = null, residual = null, oiChange = null, fundingRate = null, invalidation = null, failedGates = "", flags = "",
            confirmations = 1, reason = "", engineVersion = "", configHash = "", isSignal = true, paperStatus = status, paperNet = net,
        )
        val few = Paper.summarize(List(5) { hit("WIN", 0.01) })
        assertTrue(few.verdict!!.startsWith("Too few"))
        val bad = Paper.summarize(List(10) { hit("WIN", 0.005) } + List(30) { hit("LOSS", -0.012) })
        assertEquals(0.25, bad.winRate, 1e-12)
        assertTrue(bad.verdict!!.startsWith("Worse"))
        val fine = Paper.summarize(List(20) { hit("WIN", 0.008) } + List(20) { hit("LOSS", -0.012) })
        assertNull(fine.verdict)
    }
}
