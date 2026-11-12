package com.smartmoney.engine.replay

import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** SYNTHETIC DATA (unit test only): cost model K1. */
class CostModelTest {
    private val day15 = 1_789_430_400_000L // 2026-09-15 00:00 UTC
    private val model = CostModel(
        tickSize = mapOf("XUSDT" to 0.1),
        depth = mapOf("XUSDT" to listOf(DepthSample(day15, bidNotional1 = 2_000_000.0, askNotional1 = 1_000_000.0))),
        funding = mapOf("XUSDT" to listOf(FundingEvent(day15 + 8 * HOUR, 0.0001), FundingEvent(day15 + 16 * HOUR, -0.0002))),
    )

    @Test
    fun feesSpreadAndSlippageOnBothSides() {
        val t = day15 + DAY + HOUR // the day after the sample
        val c = model.roundTrip("XUSDT", dir = 1, sizeUsd = 1_000.0, signalTime = t, entryPrice = 100.0, exitPrice = 100.0, entryTime = t, exitTime = t + 30 * MINUTE)!!
        assertEquals(0.001, c.fee, 1e-15, "0.05% taker fee, entry and exit")
        assertEquals(0.001, c.spread, 1e-15, "half of a 0.1 tick at price 100, twice")
        // Buy entry walks the asks (1M within 1%), sell exit walks the bids (2M within 1%).
        assertEquals(0.005 * 1_000 / 1_000_000 + 0.005 * 1_000 / 2_000_000, c.slippage, 1e-15)
        assertEquals(0.0, c.funding)
    }

    @Test
    fun depthIsUsedOnlyFromAnEarlierDay() {
        assertNull(model.slippage("XUSDT", 1_000.0, true, day15 + 10 * HOUR), "same UTC day as the sample: not known yet")
        assertEquals(5e-6, model.slippage("XUSDT", 1_000.0, true, day15 + DAY)!!, 1e-15)
        assertNull(model.roundTrip("XUSDT", 1, 1_000.0, day15 + 10 * HOUR, 100.0, 100.0, day15, day15 + HOUR), "no cost estimate: excluded")
        assertNull(model.slippage("NOPEUSDT", 1_000.0, true, day15 + 5 * DAY))
    }

    @Test
    fun fundingInsideTheHoldWindowOnly() {
        val settle = day15 + 8 * HOUR
        assertEquals(0.0001, model.fundingCost("XUSDT", 1, settle - 10 * MINUTE, settle + 10 * MINUTE), 1e-15, "a long pays a positive rate")
        assertEquals(-0.0001, model.fundingCost("XUSDT", -1, settle - 10 * MINUTE, settle + 10 * MINUTE), 1e-15, "a short receives it")
        assertEquals(0.0, model.fundingCost("XUSDT", 1, settle, settle + 10 * MINUTE), "settlement at entry: before the position existed")
        assertEquals(0.0001, model.fundingCost("XUSDT", 1, settle - 10 * MINUTE, settle), 1e-15, "settlement at exit counts")
        assertEquals(0.0001 - 0.0002, model.fundingCost("XUSDT", 1, settle - MINUTE, day15 + 16 * HOUR), 1e-15)
    }

    @Test
    fun missingTickUsesTheFlaggedFallback() {
        assertEquals(0.0001, model.halfSpread("NOPEUSDT", 50.0))
        assertEquals(0.0005, model.halfSpread("XUSDT", 100.0), 1e-15)
    }

    @Test
    fun depthFileGivesMedianNotionalPerSide() {
        val f = File.createTempFile("bookDepth", ".zip").apply { deleteOnExit() }
        ZipOutputStream(f.outputStream()).use { z ->
            z.putNextEntry(ZipEntry("X-bookDepth.csv"))
            val rows = buildString {
                appendLine("timestamp,percentage,depth,notional")
                for ((i, n) in listOf(100.0, 300.0, 200.0).withIndex()) {
                    appendLine("2026-09-15 00:0$i:00,-1,1,$n")
                    appendLine("2026-09-15 00:0$i:00,1,1,${n * 2}")
                    appendLine("2026-09-15 00:0$i:00,-5,1,99999")
                }
            }
            z.write(rows.toByteArray())
            z.closeEntry()
        }
        val d = CostModel.depthFromFile(f, day15)!!
        assertEquals(200.0, d.bidNotional1)
        assertEquals(400.0, d.askNotional1)
    }
}
