package com.smartmoney.engine.replay.v03

import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.replay.FIVE_MIN
import com.smartmoney.engine.replay.MINUTE
import com.smartmoney.engine.replay.Minutes

/** E006 Stage 3 entries. M2 = market at t+2m (primary), M5 = market at t+5m (+3 min sensitivity). */
enum class Entry(val label: String) { M2("market +2m"), FT("follow-through"), LIM("limit pullback"), M5("market +5m") }

enum class StopKind { ATR, STRUCTURE }

data class Exit(val label: String, val tpR: Double, val stop: StopKind, val horizonMin: Int, val partial: Boolean = false)

/** E006 Stage 3 exits, in pre-registered order. Index 0 is the base exit (v0.2 plan). */
val EXITS: List<Exit> = listOf(
    Exit("TP 1R, 30 min", 1.0, StopKind.ATR, 30),
    Exit("TP 1R, 60 min", 1.0, StopKind.ATR, 60),
    Exit("TP 1R, 120 min", 1.0, StopKind.ATR, 120),
    Exit("TP 1.5R, 30 min", 1.5, StopKind.ATR, 30),
    Exit("TP 1.5R, 60 min", 1.5, StopKind.ATR, 60),
    Exit("TP 1.5R, 120 min", 1.5, StopKind.ATR, 120),
    Exit("TP 2R, 30 min", 2.0, StopKind.ATR, 30),
    Exit("TP 2R, 60 min", 2.0, StopKind.ATR, 60),
    Exit("TP 2R, 120 min", 2.0, StopKind.ATR, 120),
    Exit("structure stop, TP 1.5R, 60 min", 1.5, StopKind.STRUCTURE, 60),
    Exit("half at 1R, rest at 2R, 120 min", 2.0, StopKind.ATR, 120, partial = true),
)

enum class Fill { WIN, LOSS, TIMEOUT, INVALID, NOFILL }

class SimOut(
    val fill: Fill,
    val gross: Double = Double.NaN,
    val entryTime: Long = 0,
    val entryPrice: Double = Double.NaN,
    val exitMinute: Long = 0,
    val exitPrice: Double = Double.NaN,
    val maker: Boolean = false,
) {
    val traded: Boolean get() = fill == Fill.WIN || fill == Fill.LOSS || fill == Fill.TIMEOUT
}

/**
 * Trade simulation on 1m candles for the signal bar [i] (closing at t), direction [d], 1-ATR width [atr] in price.
 * Conservative intra-minute rules: stop and target in one candle = stop first; in a limit order's fill minute only the
 * stop is checked (the fill may have come before a further drop). Any missing minute in the window = INVALID.
 */
object Sim {
    fun run(m: Minutes, bars: List<Candle>, barIndex: Map<Long, Int>, i: Int, d: Int, atr: Double, entry: Entry, exit: Exit): SimOut {
        if (!(atr > 0)) return SimOut(Fill.INVALID)
        val bar = bars[i]
        val t = bar.openTime + FIVE_MIN
        var entryPrice: Double
        val entryTime: Long
        var first: Int
        var maker = false
        var fillMinuteStopOnly = false
        when (entry) {
            Entry.M2, Entry.M5, Entry.FT -> {
                val at = when (entry) {
                    Entry.M2 -> t + 2 * MINUTE
                    Entry.M5 -> t + 5 * MINUTE
                    else -> {
                        val next = barIndex[t] ?: return SimOut(Fill.INVALID)
                        if (d * (bars[next].close - bar.close) <= 0) return SimOut(Fill.NOFILL)
                        t + FIVE_MIN + 2 * MINUTE
                    }
                }
                first = m.idx(at)
                if (first < 0) return SimOut(Fill.INVALID)
                entryPrice = m.o[first]
                entryTime = at
            }
            Entry.LIM -> {
                val limit = (bar.high + bar.low) / 2
                val start = m.idx(t + 2 * MINUTE)
                if (start < 0 || !m.contiguous(start, 15)) return SimOut(Fill.INVALID)
                var k = -1
                for (j in start until start + 15) {
                    if (if (d == 1) m.l[j] <= limit else m.h[j] >= limit) { k = j; break }
                }
                if (k < 0) return SimOut(Fill.NOFILL)
                entryPrice = if (d == 1) minOf(limit, m.o[k]) else maxOf(limit, m.o[k])
                entryTime = m.t[k]
                first = k
                maker = true
                fillMinuteStopOnly = true
            }
        }
        if (!(entryPrice > 0) || !m.contiguous(first, exit.horizonMin)) return SimOut(Fill.INVALID)

        val stopDist = when (exit.stop) {
            StopKind.ATR -> atr
            StopKind.STRUCTURE -> (if (d == 1) entryPrice - bar.low else bar.high - entryPrice).coerceIn(0.5 * atr, 2.0 * atr)
        }
        val stop = entryPrice - d * stopDist
        val target = entryPrice + d * exit.tpR * stopDist
        val oneR = entryPrice + d * stopDist
        var bookedHalf = false
        var curStop = stop

        fun hitStop(j: Int) = if (d == 1) m.l[j] <= curStop else m.h[j] >= curStop
        fun hit(j: Int, level: Double) = if (d == 1) m.h[j] >= level else m.l[j] <= level
        fun ret(price: Double) = d * (price / entryPrice - 1)
        fun done(fill: Fill, j: Int, price: Double): SimOut {
            val g = if (bookedHalf) 0.5 * ret(oneR) + 0.5 * ret(price) else ret(price)
            return SimOut(fill, g, entryTime, entryPrice, m.t[j], price, maker)
        }

        for (k in 0 until exit.horizonMin) {
            val j = first + k
            if (k == 0 && fillMinuteStopOnly) {
                if (hitStop(j)) return done(Fill.LOSS, j, curStop)
                continue
            }
            val s = hitStop(j)
            if (exit.partial && !bookedHalf) {
                val r1 = hit(j, oneR)
                if (s) return done(Fill.LOSS, j, curStop) // stop and 1R in one candle: stop first
                if (r1) {
                    bookedHalf = true
                    curStop = entryPrice
                }
                continue
            }
            val tp = hit(j, target)
            if (s) return done(if (bookedHalf) Fill.WIN else Fill.LOSS, j, curStop)
            if (tp) return done(Fill.WIN, j, target)
        }
        val last = first + exit.horizonMin - 1
        return done(if (bookedHalf) Fill.WIN else Fill.TIMEOUT, last, m.c[last])
    }
}
