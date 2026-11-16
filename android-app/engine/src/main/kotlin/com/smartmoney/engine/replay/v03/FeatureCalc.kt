package com.smartmoney.engine.replay.v03

import com.smartmoney.engine.features.Features
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.replay.DAY
import com.smartmoney.engine.replay.FIVE_MIN
import com.smartmoney.engine.replay.FundingEvent
import com.smartmoney.engine.replay.HOUR
import com.smartmoney.engine.replay.MINUTE
import com.smartmoney.engine.replay.Minutes
import kotlin.math.abs
import kotlin.math.ln

/** E006 confirmations, in pre-registered order (index = position in [FeatureRow.pass] and [FeatureRow.x]). */
val CONFIRMATIONS = listOf(
    "C1 1h+4h EMA50 trend", "C2 BTC 15m not opposing", "C3 relative volume (time of day) >= 2", "C4 taker flow 55%",
    "C5 open interest rising", "C6 funding not crowded", "C7 Donchian(20) breakout", "C8 close in top/bottom 25%",
    "X1 EMA stack 5m+1h", "X2 session VWAP side", "X3 ADX(14) 1h > 20 with DI", "X4 RSI(14) 50-70 / 30-50",
    "X5 MACD histogram expanding", "X6 1h rate of change agrees", "X7 Bollinger squeeze before", "X8 ATR percentile <= 80",
    "X9 prior-day high/low breakout", "X10 long/short ratio contrarian", "X11 ETH 15m not opposing",
)

/** Pass flags (unknown = false) and signed continuous values (unknown = NaN) for one signal. */
class FeatureRow(val pass: BooleanArray, val x: DoubleArray)

/** Higher-timeframe bars built from complete runs of 5m bars. */
class Htf(bars: List<Candle>, periodMs: Long) {
    val open: LongArray
    val h: DoubleArray
    val l: DoubleArray
    val c: DoubleArray
    private val period = periodMs

    init {
        val per = (periodMs / FIVE_MIN).toInt()
        val o = ArrayList<Long>(); val hh = ArrayList<Double>(); val ll = ArrayList<Double>(); val cc = ArrayList<Double>()
        var i = 0
        while (i < bars.size) {
            val start = bars[i].openTime - Math.floorMod(bars[i].openTime, periodMs)
            if (bars[i].openTime == start && i + per - 1 < bars.size && bars[i + per - 1].openTime == start + periodMs - FIVE_MIN) {
                var hi = bars[i].high; var lo = bars[i].low
                for (k in i until i + per) { hi = maxOf(hi, bars[k].high); lo = minOf(lo, bars[k].low) }
                o += start; hh += hi; ll += lo; cc += bars[i + per - 1].close
                i += per
            } else {
                i++
            }
        }
        open = o.toLongArray(); h = hh.toDoubleArray(); l = ll.toDoubleArray(); c = cc.toDoubleArray()
    }

    /** Index of the last bar that has closed at or before [t], or -1. */
    fun lastClosed(t: Long): Int {
        var lo = 0
        var hi = open.size - 1
        var ans = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (open[mid] + period <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
        }
        return ans
    }
}

/** 5m open interest and long/short account ratio from the metrics archive, oldest first. */
class MetricsSeries(val t: LongArray, val oi: DoubleArray, val lsr: DoubleArray) {
    /** Index of the last row at or before [time] and no older than [maxAge], or -1. */
    fun asOf(time: Long, maxAge: Long = 10 * MINUTE): Int {
        var i = java.util.Arrays.binarySearch(t, time)
        if (i < 0) i = -i - 2
        return if (i >= 0 && time - t[i] <= maxAge) i else -1
    }
}

/**
 * Computes the E006 confirmations for one symbol. Everything at signal time t uses 5m bars up to the signal bar,
 * higher-timeframe bars that have closed by t, metrics up to t - 5m, and funding settled by t.
 */
class FeatureCalc(
    private val sym: String,
    private val m: Minutes,
    private val bars: List<Candle>,
    private val barIndex: Map<Long, Int>,
    private val btcClose: Map<Long, Double>,
    private val ethClose: Map<Long, Double>,
    private val metrics: MetricsSeries?,
    private val lastFunding: (Long) -> Double?,
) {
    private val close = DoubleArray(bars.size) { bars[it].close }
    private val ema20 = Indicators.ema(close, 20)
    private val ema50 = Indicators.ema(close, 50)
    private val ema200 = Indicators.ema(close, 200)
    private val rsi = Indicators.rsi(close, 14)
    private val macd = Indicators.macdHist(close)
    private val bbw = Indicators.bollingerWidth(close)
    private val atrPct = DoubleArray(bars.size) { Features.atrPct(bars, it) ?: Double.NaN }
    private val h1 = Htf(bars, HOUR)
    private val h4 = Htf(bars, 4 * HOUR)
    private val e50h1 = Indicators.ema(h1.c, 50)
    private val e20h1 = Indicators.ema(h1.c, 20)
    private val e200h1 = Indicators.ema(h1.c, 200)
    private val adx1h = Indicators.adx(h1.h, h1.l, h1.c, 14)
    private val e50h4 = Indicators.ema(h4.c, 50)
    private val dayHigh = HashMap<Long, Double>()
    private val dayLow = HashMap<Long, Double>()

    init {
        for (b in bars) {
            val d = b.openTime - Math.floorMod(b.openTime, DAY)
            dayHigh[d] = maxOf(dayHigh[d] ?: Double.NEGATIVE_INFINITY, b.high)
            dayLow[d] = minOf(dayLow[d] ?: Double.POSITIVE_INFINITY, b.low)
        }
    }

    fun compute(i: Int, d: Int): FeatureRow {
        val n = CONFIRMATIONS.size
        val pass = BooleanArray(n)
        val x = DoubleArray(n) { Double.NaN }
        val b = bars[i]
        val t = b.openTime + FIVE_MIN
        val c = b.close
        val atrPrice = if (i >= 1 && !atrPct[i].isNaN()) atrPct[i] * bars[i - 1].close else Double.NaN
        fun set(k: Int, p: Boolean, v: Double) { pass[k] = p && !v.isNaN(); x[k] = v }

        // C1: 1h and 4h EMA50 (closed bars only).
        val j1 = h1.lastClosed(t)
        val j4 = h4.lastClosed(t)
        val ea = if (j1 >= 0) e50h1[j1] else Double.NaN
        val eb = if (j4 >= 0) e50h4[j4] else Double.NaN
        if (!ea.isNaN() && !eb.isNaN()) set(0, d * (c - ea) > 0 && d * (c - eb) > 0, (d * (c / ea - 1) + d * (c / eb - 1)) / 2)

        // C2 / X11: BTC and ETH 15-minute move.
        fun ctx(map: Map<Long, Double>): Double {
            val now = map[t - FIVE_MIN] ?: return Double.NaN
            val before = map[t - 4 * FIVE_MIN] ?: return Double.NaN
            return if (before > 0) d * (now / before - 1) else Double.NaN
        }
        if (sym == "BTCUSDT") set(1, true, 0.0) else ctx(btcClose).let { set(1, it >= 0, it) }
        (if (sym == "ETHUSDT") ctx(btcClose) else ctx(ethClose)).let { set(18, it >= 0, it) }

        // C3: relative volume vs the same UTC slot on the previous 20 days.
        b.quoteVolume?.let { qv ->
            val prev = (1..20).mapNotNull { k -> barIndex[b.openTime - k * DAY]?.let { bars[it].quoteVolume } }
            if (prev.size >= 10 && prev.average() > 0) {
                val rv = qv / prev.average()
                if (rv > 0) set(2, rv >= 2.0, ln(rv))
            }
        }

        // C4: taker-buy share of the signal bar.
        val k0 = m.idx(b.openTime)
        if (k0 >= 0 && m.contiguous(k0, 5)) {
            var tb = 0.0; var q = 0.0
            for (k in k0 until k0 + 5) { tb += m.tbq[k]; q += m.qv[k] }
            if (q > 0 && !tb.isNaN()) {
                val share = tb / q
                set(3, if (d == 1) share >= 0.55 else share <= 0.45, d * (share - 0.5))
            }
        }

        // C5 / X10: metrics with one 5m period of lag.
        if (metrics != null) {
            val a = metrics.asOf(t - FIVE_MIN)
            val z = metrics.asOf(t - 4 * FIVE_MIN)
            if (a >= 0 && z >= 0 && metrics.oi[z] > 0 && a != z) {
                val ch = metrics.oi[a] / metrics.oi[z] - 1
                set(4, ch > 0, ch)
            }
            if (a >= 0 && !metrics.lsr[a].isNaN()) {
                val from = java.util.Arrays.binarySearch(metrics.t, t - FIVE_MIN - 7 * DAY).let { if (it < 0) -it - 1 else it }
                val window = (from until a).map { metrics.lsr[it] }.filter { !it.isNaN() }
                if (window.size >= 500) {
                    val med = window.sorted()[window.size / 2]
                    if (med > 0) {
                        val r = metrics.lsr[a]
                        set(17, if (d == 1) r <= med else r >= med, -d * (r / med - 1))
                    }
                }
            }
        }

        // C6: funding veto.
        lastFunding(t)?.let { f -> set(5, d * f < 0.0005, -d * f) }

        // C7: Donchian(20).
        if (i >= 20 && !atrPrice.isNaN()) {
            var hi = Double.NEGATIVE_INFINITY; var lo = Double.POSITIVE_INFINITY
            for (k in i - 20 until i) { hi = maxOf(hi, bars[k].high); lo = minOf(lo, bars[k].low) }
            val edge = if (d == 1) hi else lo
            set(6, d * (c - edge) > 0, d * (c - edge) / atrPrice)
        }

        // C8: close location.
        val range = b.high - b.low
        if (range > 0) {
            val cl = (c - b.low) / range
            set(7, if (d == 1) cl >= 0.75 else cl <= 0.25, d * (cl - 0.5))
        }

        // X1: EMA stacks on 5m and 1h.
        fun stack(a: Double, bb: Double, cc: Double) = if (a.isNaN() || bb.isNaN() || cc.isNaN()) null else if (d == 1) a > bb && bb > cc else a < bb && bb < cc
        val s5 = stack(ema20[i], ema50[i], ema200[i])
        val s1 = if (j1 >= 0) stack(e20h1[j1], e50h1[j1], e200h1[j1]) else null
        if (s5 != null && s1 != null) set(8, s5 && s1, (if (s5) 1.0 else 0.0) + (if (s1) 1.0 else 0.0) - 1)

        // X2: session VWAP of the UTC day up to t.
        val day = b.openTime - Math.floorMod(b.openTime, DAY)
        val ds = m.idxAtOrAfter(day)
        val de = m.idxAtOrAfter(t)
        if (de > ds) {
            var pv = 0.0; var v = 0.0
            for (k in ds until de) { pv += m.qv[k]; v += m.v[k] }
            if (v > 0) { val vwap = pv / v; set(9, d * (c - vwap) > 0, d * (c / vwap - 1)) }
        }

        // X3: ADX(14) on 1h.
        if (j1 >= 0 && !adx1h.adx[j1].isNaN()) {
            val agree = if (d == 1) adx1h.plusDi[j1] > adx1h.minusDi[j1] else adx1h.minusDi[j1] > adx1h.plusDi[j1]
            set(10, adx1h.adx[j1] > 20 && agree, (adx1h.adx[j1] - 20) / 20 * (if (agree) 1 else -1))
        }

        // X4: RSI(14) band.
        if (!rsi[i].isNaN()) {
            val r = rsi[i]
            set(11, if (d == 1) r in 50.0..70.0 else r in 30.0..50.0, -abs(r - if (d == 1) 60.0 else 40.0))
        }

        // X5: MACD histogram expanding in direction d.
        if (i >= 1 && !macd[i].isNaN() && !macd[i - 1].isNaN() && !atrPrice.isNaN()) {
            set(12, d * macd[i] > 0 && abs(macd[i]) > abs(macd[i - 1]), d * (macd[i] - macd[i - 1]) / atrPrice)
        }

        // X6: 1h rate of change.
        barIndex[b.openTime - 12 * FIVE_MIN]?.let { k -> val roc = d * (c / bars[k].close - 1); set(13, roc > 0, roc) }

        // X7: squeeze on the bar before the signal bar.
        if (i >= 102 && !bbw[i - 1].isNaN()) {
            val p = Indicators.percentile(bbw, i - 101, i - 1, bbw[i - 1])
            if (!p.isNaN()) set(14, p <= 0.2, -p)
        }

        // X8: ATR percentile over the previous 7 days of bars.
        if (!atrPct[i].isNaN()) {
            val p = Indicators.percentile(atrPct, i - 2016, i, atrPct[i], min = 500)
            if (!p.isNaN()) set(15, p <= 0.8, -p)
        }

        // X9: prior UTC day's high / low.
        val prevDay = day - DAY
        val level = if (d == 1) dayHigh[prevDay] else dayLow[prevDay]
        if (level != null && !atrPrice.isNaN()) set(16, d * (c - level) > 0, d * (c - level) / atrPrice)

        return FeatureRow(pass, x)
    }

    companion object {
        /** Parses the metrics archive's daily files (create_time, symbol, sum_open_interest, ..., count_long_short_ratio at 6). */
        fun metricsFrom(files: List<java.io.File>): MetricsSeries? {
            val rows = java.util.TreeMap<Long, DoubleArray>()
            val fmt = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            for (f in files) com.smartmoney.engine.replay.Archive.forEachRow(f) { r ->
                if (r.size < 7) return@forEachRow
                val time = try {
                    java.time.LocalDateTime.parse(r[0].trim(), fmt).toInstant(java.time.ZoneOffset.UTC).toEpochMilli()
                } catch (e: Exception) {
                    return@forEachRow
                }
                rows[time] = doubleArrayOf(r[2].toDoubleOrNull() ?: Double.NaN, r[6].toDoubleOrNull() ?: Double.NaN)
            }
            if (rows.isEmpty()) return null
            return MetricsSeries(rows.keys.toLongArray(), rows.values.map { it[0] }.toDoubleArray(), rows.values.map { it[1] }.toDoubleArray())
        }
    }
}
