package com.smartmoney.engine.features

import com.smartmoney.engine.model.BookLevel
import com.smartmoney.engine.model.OrderBook

/**
 * Order-book liquidity (live-only: no exchange gives history of full books for free). Slippage = how far the average
 * fill of a market order of a given size lands from the mid price, walking the visible book. Null = the visible book
 * is too thin to fill that size.
 */
data class DepthInfo(
    val time: Long,
    val mid: Double,
    val spread: Double,
    val bidUsdWithin05: Double,
    val askUsdWithin05: Double,
    val bidUsdWithin1: Double,
    val askUsdWithin1: Double,
    /** Trade size in USD -> slippage fraction of a market BUY. */
    val buySlippage: Map<Double, Double?>,
    /** Trade size in USD -> slippage fraction of a market SELL. */
    val sellSlippage: Map<Double, Double?>,
)

object Liquidity {
    fun analyze(book: OrderBook, tradeSizesUsd: List<Double>): DepthInfo? {
        val bestBid = book.bids.maxByOrNull { it.price }?.price ?: return null
        val bestAsk = book.asks.minByOrNull { it.price }?.price ?: return null
        if (bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) return null
        val mid = (bestBid + bestAsk) / 2
        val bids = book.bids.sortedByDescending { it.price }
        val asks = book.asks.sortedBy { it.price }
        return DepthInfo(
            time = book.time,
            mid = mid,
            spread = (bestAsk - bestBid) / mid,
            bidUsdWithin05 = usdWithin(bids, mid, 0.005, buySide = true),
            askUsdWithin05 = usdWithin(asks, mid, 0.005, buySide = false),
            bidUsdWithin1 = usdWithin(bids, mid, 0.01, buySide = true),
            askUsdWithin1 = usdWithin(asks, mid, 0.01, buySide = false),
            buySlippage = tradeSizesUsd.associateWith { slippage(asks, mid, it) },
            sellSlippage = tradeSizesUsd.associateWith { slippage(bids, mid, it) },
        )
    }

    private fun usdWithin(levels: List<BookLevel>, mid: Double, pct: Double, buySide: Boolean): Double {
        val limit = if (buySide) mid * (1 - pct) else mid * (1 + pct)
        return levels.filter { if (buySide) it.price >= limit else it.price <= limit }.sumOf { it.price * it.size }
    }

    /** [levels] sorted best first. Returns |average fill / mid - 1|, or null if the book cannot fill [usd]. */
    fun slippage(levels: List<BookLevel>, mid: Double, usd: Double): Double? {
        if (usd <= 0 || mid <= 0) return 0.0
        var remaining = usd
        var qty = 0.0
        for (l in levels) {
            val levelUsd = l.price * l.size
            if (levelUsd <= 0) continue
            val take = minOf(remaining, levelUsd)
            qty += take / l.price
            remaining -= take
            if (remaining <= 1e-9) break
        }
        if (remaining > 1e-9 || qty <= 0) return null
        val avg = usd / qty
        return kotlin.math.abs(avg / mid - 1)
    }
}
