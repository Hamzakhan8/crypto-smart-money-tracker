package com.smartmoney.engine.features

import com.smartmoney.engine.model.Candle

/**
 * Candles of one instrument and timeframe, oldest first, one per open time. A closed candle is never replaced by an
 * unclosed one (a late in-progress update cannot undo a final candle). Immutable: [merge] returns a new series.
 */
class CandleSeries private constructor(val candles: List<Candle>, private val maxSize: Int) {

    constructor(maxSize: Int = 300) : this(emptyList(), maxSize)

    val size: Int get() = candles.size
    val last: Candle? get() = candles.lastOrNull()
    val lastClosed: Candle? get() = candles.lastOrNull { it.closed }

    fun merge(incoming: Collection<Candle>): CandleSeries {
        if (incoming.isEmpty()) return this
        val byTime = java.util.TreeMap<Long, Candle>()
        for (c in candles) byTime[c.openTime] = c
        for (c in incoming) {
            val old = byTime[c.openTime]
            if (old != null && old.closed && !c.closed) continue
            byTime[c.openTime] = c
        }
        val all = byTime.values.toList()
        return CandleSeries(if (all.size > maxSize) all.subList(all.size - maxSize, all.size).toList() else all, maxSize)
    }

    fun merge(c: Candle): CandleSeries = merge(listOf(c))

    /** Open time of the newest closed candle, or null. */
    val lastClosedOpenTime: Long? get() = lastClosed?.openTime
}
