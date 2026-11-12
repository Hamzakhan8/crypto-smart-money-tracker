package com.smartmoney.engine.features

import com.smartmoney.engine.model.BookLevel
import com.smartmoney.engine.model.OrderBook
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** SYNTHETIC DATA (unit test only): a hand-built order book. */
class LiquidityTest {
    private val book = OrderBook(
        bids = listOf(BookLevel(99.9, 10.0), BookLevel(99.0, 20.0)),
        asks = listOf(BookLevel(100.0, 5.0), BookLevel(101.0, 10.0)),
        time = 1,
    )

    @Test
    fun slippageWalksTheBook() {
        val d = Liquidity.analyze(book, listOf(1_000.0, 10_000.0))!!
        val mid = (99.9 + 100.0) / 2
        // $1,000 buy: $500 at 100 (5 coins) + $500 at 101 (4.9505 coins).
        val qty = 5.0 + 500.0 / 101.0
        assertEquals(1_000.0 / qty / mid - 1, d.buySlippage[1_000.0]!!, 1e-12)
        assertNull(d.buySlippage[10_000.0], "visible asks hold only $1,510")
        assertEquals((100.0 - 99.9) / mid, d.spread, 1e-12)
        assertEquals(500.0, d.askUsdWithin1, 1e-9, "101 is 1.05% above the mid, outside 1%")
        assertEquals(99.9 * 10 + 99.0 * 20, d.bidUsdWithin1, 1e-9)
        assertEquals(99.9 * 10, d.bidUsdWithin05, 1e-9)
    }

    @Test
    fun emptyOrCrossedBookGivesNothing() {
        assertNull(Liquidity.analyze(OrderBook(emptyList(), book.asks, 1), listOf(1_000.0)))
        assertNull(Liquidity.analyze(OrderBook(listOf(BookLevel(101.0, 1.0)), listOf(BookLevel(100.0, 1.0)), 1), listOf(1_000.0)))
    }
}
