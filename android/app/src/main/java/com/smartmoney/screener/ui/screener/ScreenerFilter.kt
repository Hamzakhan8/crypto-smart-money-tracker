package com.smartmoney.screener.ui.screener

import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.screener.Direction
import com.smartmoney.engine.screener.ScreenerRow
import com.smartmoney.engine.screener.Tier
import kotlin.math.abs

enum class TierFilter(val label: String) { ALL("All coins"), SIGNALS("Signals (LONG / SHORT / BUY)"), MOVING("Moving"), CONFIRMED("Confirmed"), WATCH("Watch"), REJECTED("Rejected") }

enum class TypeFilter(val label: String) { ANY("Up and down"), PUMP("Up only"), DUMP("Down only") }

enum class SortBy(val label: String) { MOVE("Move vs ATR"), RELVOL("Relative volume"), RESIDUAL("BTC-adjusted move"), VOLUME("24h volume") }

/** Screener filters. Pure: [apply] is unit-tested without Android. */
data class ScreenerFilter(
    val market: Market = Market.SPOT,
    val exchanges: Set<Exchange> = Exchange.entries.toSet(),
    val tier: TierFilter = TierFilter.ALL,
    val type: TypeFilter = TypeFilter.ANY,
    /** Minimum |move| in ATRs (the volatility-normalized move). */
    val minZ: Double = 0.0,
    val minVolume24h: Double = 0.0,
    val query: String = "",
    val sort: SortBy = SortBy.MOVE,
) {
    val isDefault: Boolean get() = copy(market = Market.SPOT) == ScreenerFilter()

    fun apply(rows: List<ScreenerRow>): List<ScreenerRow> {
        val q = query.trim().uppercase()
        return rows.asSequence()
            .filter { it.instrument.market == market && it.instrument.exchange in exchanges }
            .filter {
                when (tier) {
                    TierFilter.ALL -> true
                    TierFilter.SIGNALS -> it.tier == Tier.CONFIRMED && it.label != null
                    TierFilter.MOVING -> it.tier != Tier.NONE
                    TierFilter.CONFIRMED -> it.tier == Tier.CONFIRMED
                    TierFilter.WATCH -> it.tier == Tier.WATCH
                    TierFilter.REJECTED -> it.tier == Tier.REJECTED
                }
            }
            .filter {
                when (type) {
                    TypeFilter.ANY -> true
                    TypeFilter.PUMP -> it.direction == Direction.UP
                    TypeFilter.DUMP -> it.direction == Direction.DOWN
                }
            }
            .filter { minZ <= 0.0 || (it.focus?.zMove?.let { z -> abs(z) >= minZ } ?: false) }
            .filter { minVolume24h <= 0.0 || (it.ticker?.quoteVolume24h ?: 0.0) >= minVolume24h }
            .filter { q.isEmpty() || it.instrument.canonical.contains(q) || it.instrument.nativeSymbol.uppercase().contains(q) }
            .sortedWith(compareByDescending<ScreenerRow, Double?>(nullsFirst()) { key(it) }.thenBy { it.instrument.canonical })
            .toList()
    }

    /** Sort key; null (n/a) sorts last. */
    private fun key(r: ScreenerRow): Double? = when (sort) {
        SortBy.MOVE -> r.focus?.zMove?.let { abs(it) }
        SortBy.RELVOL -> r.focus?.relVolume
        SortBy.RESIDUAL -> r.focus?.residual?.let { abs(it) }
        SortBy.VOLUME -> r.ticker?.quoteVolume24h
    }
}
