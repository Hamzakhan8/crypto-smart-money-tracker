package com.smartmoney.engine.replay

/** One bookDepth day: median notional within 1% below (bids) and above (asks) the mid. */
data class DepthSample(val dayStart: Long, val bidNotional1: Double, val askNotional1: Double)

data class FundingEvent(val time: Long, val rate: Double)

data class Costs(val fee: Double, val spread: Double, val slippage: Double, val funding: Double) {
    val total: Double get() = fee + spread + slippage + funding
}

/**
 * Pre-registration K1. Per side: taker fee + half-spread (0.5 tick / price) + linear-book slippage
 * (0.5% x size / notional within 1%, from the most recent depth sample strictly before the signal's UTC day).
 * Funding: every settlement in (entry, exit] costs sign x rate (a long pays a positive rate).
 */
class CostModel(
    private val tickSize: Map<String, Double>,
    private val depth: Map<String, List<DepthSample>>,
    private val funding: Map<String, List<FundingEvent>>,
    val takerFee: Double = 0.0005,
    private val fallbackHalfSpread: Double = 0.0001,
) {
    fun halfSpread(symbol: String, price: Double): Double =
        tickSize[symbol]?.takeIf { it > 0 && price > 0 }?.let { 0.5 * it / price } ?: fallbackHalfSpread

    fun hasTick(symbol: String): Boolean = tickSize.containsKey(symbol)

    /** Depth sample usable at [signalTime]: the latest one from a UTC day before the signal's day. */
    fun depthAsOf(symbol: String, signalTime: Long): DepthSample? {
        val day = signalTime - Math.floorMod(signalTime, DAY)
        return depth[symbol]?.lastOrNull { it.dayStart < day }
    }

    /** Slippage of a market order of [sizeUsd] on one side, or null without a depth sample. */
    fun slippage(symbol: String, sizeUsd: Double, buy: Boolean, signalTime: Long): Double? {
        val d = depthAsOf(symbol, signalTime) ?: return null
        val notional = if (buy) d.askNotional1 else d.bidNotional1
        if (!(notional > 0)) return null
        return 0.005 * sizeUsd / notional
    }

    /** The last settled funding rate at or before [t], or null. */
    fun lastFunding(symbol: String, t: Long): Double? = funding[symbol]?.lastOrNull { it.time <= t }?.rate

    /**
     * Round-trip costs where the entry may be a limit (maker) order: maker fee [makerFee], no spread or slippage on
     * entry; the exit is always a taker order. Null without a depth sample (as [roundTrip]).
     */
    fun trade(symbol: String, dir: Int, sizeUsd: Double, signalTime: Long, entryPrice: Double, exitPrice: Double, entryTime: Long, exitTime: Long, makerEntry: Boolean, makerFee: Double = 0.0002): Costs? {
        if (!makerEntry) return roundTrip(symbol, dir, sizeUsd, signalTime, entryPrice, exitPrice, entryTime, exitTime)
        val exitSlip = slippage(symbol, sizeUsd, buy = dir == -1, signalTime) ?: return null
        return Costs(
            fee = makerFee + takerFee,
            spread = halfSpread(symbol, exitPrice),
            slippage = exitSlip,
            funding = fundingCost(symbol, dir, entryTime, exitTime),
        )
    }

    fun fundingCost(symbol: String, dir: Int, entryTime: Long, exitTime: Long): Double =
        funding[symbol].orEmpty().filter { it.time > entryTime && it.time <= exitTime }.sumOf { dir * it.rate }

    /** Round-trip costs of a trade in direction [dir], or null when slippage cannot be estimated. */
    fun roundTrip(symbol: String, dir: Int, sizeUsd: Double, signalTime: Long, entryPrice: Double, exitPrice: Double, entryTime: Long, exitTime: Long): Costs? {
        val entrySlip = slippage(symbol, sizeUsd, buy = dir == 1, signalTime) ?: return null
        val exitSlip = slippage(symbol, sizeUsd, buy = dir == -1, signalTime) ?: return null
        return Costs(
            fee = 2 * takerFee,
            spread = halfSpread(symbol, entryPrice) + halfSpread(symbol, exitPrice),
            slippage = entrySlip + exitSlip,
            funding = fundingCost(symbol, dir, entryTime, exitTime),
        )
    }

    companion object {
        /**
         * Median notional within 1% per side from a bookDepth zip (columns: timestamp, percentage, depth, notional).
         * The level is read as a number: the archive writes both "-1" and "-1.00" (E005 fix 1).
         * Returns null for a corrupt, one-sided day (E005 change 2, see [plausible]).
         */
        fun depthFromFile(file: java.io.File, dayStart: Long): DepthSample? {
            val bids = ArrayList<Double>()
            val asks = ArrayList<Double>()
            Archive.forEachRow(file) { r ->
                if (r.size < 4) return@forEachRow
                when (r[1].trim().toDoubleOrNull()) {
                    -1.0 -> r[3].toDoubleOrNull()?.let { bids += it }
                    1.0 -> r[3].toDoubleOrNull()?.let { asks += it }
                }
            }
            if (bids.isEmpty() || asks.isEmpty()) return null
            return DepthSample(dayStart, median(bids), median(asks)).takeIf { plausible(it) }
        }

        /** E005 change 2: a side below $1,000 or below 1% of the other side within 1% is a recording error. */
        fun plausible(d: DepthSample): Boolean {
            val lo = minOf(d.bidNotional1, d.askNotional1)
            val hi = maxOf(d.bidNotional1, d.askNotional1)
            return lo >= 1_000.0 && lo >= 0.01 * hi
        }

        fun median(x: List<Double>): Double {
            val s = x.sorted()
            val m = s.size / 2
            return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
        }
    }
}
