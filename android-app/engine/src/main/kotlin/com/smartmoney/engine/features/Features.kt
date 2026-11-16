package com.smartmoney.engine.features

import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Timeframe
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

enum class Breakout { UP, DOWN, NONE }

/**
 * Features of one candle, computed only from that candle and the candles BEFORE it (no look-ahead).
 * Every value is null when there is not enough data; the UI shows null as "n/a".
 */
data class FeatureSet(
    val timeframe: Timeframe,
    val candleOpenTime: Long,
    val closed: Boolean,
    val price: Double,
    /** close / previous close - 1. */
    val move: Double?,
    /** Mean true range of the [Features.ATR_LEN] candles before this one, divided by the previous close. */
    val atrPct: Double?,
    /** move / atrPct: the move in units of the coin's usual candle range. */
    val zMove: Double?,
    /** Quote volume / median quote volume of up to [Features.BASELINE_LEN] candles before. */
    val relVolume: Double?,
    /** move - beta x BTC move on the same candle. Null for BTC itself and when BTC data is missing. */
    val residual: Double?,
    val beta: Double?,
    val breakout: Breakout?,
    /** (close - low) / (high - low): 1 = closed at the high, 0 = at the low. */
    val closeLocation: Double?,
    /** Taker buy share as -1..+1 (Binance only). */
    val takerImbalance: Double?,
    val trades: Long?,
    /** Trades / median trades of the candles before (Binance only). */
    val tradeSpike: Double?,
    /** Data problems in the window: gaps, bad timestamps, invalid candles, spike wicks, dead feed. Empty = clean. */
    val dataIssues: List<String>,
    /** Candles available before this one. */
    val history: Int,
    val high: Double,
    val low: Double,
)

object Features {
    const val ATR_LEN = 20
    const val BASELINE_LEN = 96
    const val MIN_BASELINE = 20
    const val MIN_BETA_PAIRS = 30
    const val BREAKOUT_LEN = 20

    /** A wick longer than this many ATRs beyond the candle body is treated as a bad print. */
    const val SPIKE_WICK_ATR = 15.0

    /**
     * Features of candles[index]. [candles] must be oldest first with unique open times (a [CandleSeries]).
     * [btc] maps open time to BTC's candle on the same exchange and market; pass null for BTC itself.
     */
    fun compute(candles: List<Candle>, index: Int, timeframe: Timeframe, btc: Map<Long, Candle>?): FeatureSet? {
        if (index < 0 || index >= candles.size) return null
        val c = candles[index]
        val prev = candles.getOrNull(index - 1)?.takeIf { it.openTime == c.openTime - timeframe.millis }
        val move = prev?.let { if (it.close > 0) c.close / it.close - 1.0 else null }

        val atrPct = atrPct(candles, index)
        val z = if (move != null && atrPct != null && atrPct > 0) move / atrPct else null

        val baseFrom = max(0, index - BASELINE_LEN)
        val prior = candles.subList(baseFrom, index)
        val relVol = c.quoteVolume?.let { qv ->
            val vols = prior.mapNotNull { it.quoteVolume }
            if (vols.size < MIN_BASELINE) null else median(vols).takeIf { it > 0 }?.let { qv / it }
        }
        val tradeSpike = c.trades?.let { n ->
            val ts = prior.mapNotNull { it.trades?.toDouble() }
            if (ts.size < MIN_BASELINE) null else median(ts).takeIf { it > 0 }?.let { n / it }
        }

        var beta: Double? = null
        var residual: Double? = null
        if (btc != null && move != null) {
            beta = beta(candles, index, timeframe, btc)
            val b = btc[c.openTime]
            val bPrev = btc[c.openTime - timeframe.millis]
            if (beta != null && b != null && bPrev != null && bPrev.close > 0) {
                residual = move - beta * (b.close / bPrev.close - 1.0)
            }
        }

        val breakout = if (index >= BREAKOUT_LEN) {
            val w = candles.subList(index - BREAKOUT_LEN, index)
            when {
                c.close > w.maxOf { it.high } -> Breakout.UP
                c.close < w.minOf { it.low } -> Breakout.DOWN
                else -> Breakout.NONE
            }
        } else null

        val range = c.high - c.low
        val closeLoc = if (range > 0) (c.close - c.low) / range else null
        val taker = c.takerBuyQuote?.let { tb -> c.quoteVolume?.takeIf { it > 0 }?.let { (2.0 * tb / it - 1.0).coerceIn(-1.0, 1.0) } }

        return FeatureSet(
            timeframe = timeframe, candleOpenTime = c.openTime, closed = c.closed, price = c.close,
            move = move, atrPct = atrPct, zMove = z, relVolume = relVol, residual = residual, beta = beta,
            breakout = breakout, closeLocation = closeLoc, takerImbalance = taker, trades = c.trades, tradeSpike = tradeSpike,
            dataIssues = dataIssues(candles, index, timeframe, atrPct), history = index, high = c.high, low = c.low,
        )
    }

    /** Mean true range of the ATR_LEN candles before [index], as a fraction of the previous close. */
    fun atrPct(candles: List<Candle>, index: Int): Double? {
        if (index < ATR_LEN + 1) return null
        var sum = 0.0
        for (j in index - ATR_LEN until index) {
            val k = candles[j]
            val pc = candles[j - 1].close
            sum += max(k.high - k.low, max(abs(k.high - pc), abs(k.low - pc)))
        }
        val ref = candles[index - 1].close
        if (ref <= 0) return null
        return (sum / ATR_LEN) / ref
    }

    /** Beta of the coin's candle returns to BTC's over the candles before [index] (same open times only). */
    fun beta(candles: List<Candle>, index: Int, timeframe: Timeframe, btc: Map<Long, Candle>): Double? {
        val xs = ArrayList<Double>()
        val ys = ArrayList<Double>()
        val from = max(1, index - BASELINE_LEN)
        for (j in from until index) {
            val a = candles[j]
            val ap = candles[j - 1]
            if (ap.openTime != a.openTime - timeframe.millis || ap.close <= 0) continue
            val b = btc[a.openTime] ?: continue
            val bp = btc[a.openTime - timeframe.millis] ?: continue
            if (bp.close <= 0) continue
            ys += a.close / ap.close - 1.0
            xs += b.close / bp.close - 1.0
        }
        if (xs.size < MIN_BETA_PAIRS) return null
        val mx = xs.average()
        val my = ys.average()
        var cov = 0.0
        var varX = 0.0
        for (i in xs.indices) {
            cov += (xs[i] - mx) * (ys[i] - my)
            varX += (xs[i] - mx) * (xs[i] - mx)
        }
        if (varX <= 0) return null
        return cov / varX
    }

    fun dataIssues(candles: List<Candle>, index: Int, timeframe: Timeframe, atrPct: Double?): List<String> {
        val issues = ArrayList<String>()
        val from = max(0, index - BASELINE_LEN)
        var gaps = 0
        var missing = 0L
        var zeroVol = 0
        for (j in from..index) {
            val k = candles[j]
            if (Math.floorMod(k.openTime, timeframe.millis) != 0L) {
                issues += "bad timestamp"
                break
            }
            if (j > from) {
                val step = k.openTime - candles[j - 1].openTime
                if (step <= 0) issues += "duplicate or unordered candle"
                else if (step != timeframe.millis) {
                    gaps += 1
                    missing += step / timeframe.millis - 1
                }
            }
            if (k.open <= 0 || k.high <= 0 || k.low <= 0 || k.close <= 0 || k.high < max(k.open, k.close) || k.low > min(k.open, k.close)) {
                issues += "invalid candle"
            }
            if (k.baseVolume <= 0.0) zeroVol += 1
        }
        if (gaps > 0) issues += "gap: $missing missing candle${if (missing == 1L) "" else "s"}"
        val n = index - from + 1
        if (n >= MIN_BASELINE && zeroVol * 5 > n) issues += "no trades in $zeroVol of $n candles"
        val c = candles[index]
        val ref = candles.getOrNull(index - 1)?.close
        if (atrPct != null && ref != null && ref > 0) {
            val atr = atrPct * ref
            val upper = c.high - max(c.open, c.close)
            val lower = min(c.open, c.close) - c.low
            if (atr > 0 && (upper > SPIKE_WICK_ATR * atr || lower > SPIKE_WICK_ATR * atr)) issues += "spike wick (possible bad print)"
        }
        return issues.distinct()
    }

    fun median(values: List<Double>): Double {
        if (values.isEmpty()) return 0.0
        val s = values.sorted()
        val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2.0
    }
}
