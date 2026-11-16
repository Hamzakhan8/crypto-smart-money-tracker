package com.smartmoney.engine.replay.v03

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Standard indicators over arrays (index i uses values 0..i only: no look-ahead). Values before an indicator has
 * enough history are NaN.
 */
object Indicators {
    /** EMA with alpha = 2 / (n + 1), seeded with the simple mean of the first n values. */
    fun ema(x: DoubleArray, n: Int): DoubleArray {
        val out = DoubleArray(x.size) { Double.NaN }
        if (x.size < n) return out
        val a = 2.0 / (n + 1)
        var e = x.take(n).average()
        out[n - 1] = e
        for (i in n until x.size) {
            e = a * x[i] + (1 - a) * e
            out[i] = e
        }
        return out
    }

    /** Wilder RSI. */
    fun rsi(close: DoubleArray, n: Int = 14): DoubleArray {
        val out = DoubleArray(close.size) { Double.NaN }
        if (close.size <= n) return out
        var gain = 0.0
        var loss = 0.0
        for (i in 1..n) {
            val d = close[i] - close[i - 1]
            if (d > 0) gain += d else loss -= d
        }
        gain /= n
        loss /= n
        out[n] = rsiOf(gain, loss)
        for (i in n + 1 until close.size) {
            val d = close[i] - close[i - 1]
            gain = (gain * (n - 1) + max(d, 0.0)) / n
            loss = (loss * (n - 1) + max(-d, 0.0)) / n
            out[i] = rsiOf(gain, loss)
        }
        return out
    }

    private fun rsiOf(gain: Double, loss: Double): Double = if (loss == 0.0) (if (gain == 0.0) 50.0 else 100.0) else 100 - 100 / (1 + gain / loss)

    /** MACD(fast, slow, signal) histogram = (EMA fast - EMA slow) - EMA signal of that. */
    fun macdHist(close: DoubleArray, fast: Int = 12, slow: Int = 26, signal: Int = 9): DoubleArray {
        val f = ema(close, fast)
        val s = ema(close, slow)
        val macd = DoubleArray(close.size) { f[it] - s[it] }
        val firstValid = macd.indexOfFirst { !it.isNaN() }
        val out = DoubleArray(close.size) { Double.NaN }
        if (firstValid < 0) return out
        val sig = ema(macd.copyOfRange(firstValid, macd.size), signal)
        for (k in sig.indices) out[firstValid + k] = macd[firstValid + k] - sig[k]
        return out
    }

    class Adx(val adx: DoubleArray, val plusDi: DoubleArray, val minusDi: DoubleArray)

    /** Wilder ADX and DI+/DI-. */
    fun adx(h: DoubleArray, l: DoubleArray, c: DoubleArray, n: Int = 14): Adx {
        val size = c.size
        val adx = DoubleArray(size) { Double.NaN }
        val pdi = DoubleArray(size) { Double.NaN }
        val mdi = DoubleArray(size) { Double.NaN }
        if (size <= 2 * n) return Adx(adx, pdi, mdi)
        var tr = 0.0
        var pdm = 0.0
        var mdm = 0.0
        val dx = DoubleArray(size) { Double.NaN }
        for (i in 1 until size) {
            val up = h[i] - h[i - 1]
            val down = l[i - 1] - l[i]
            val p = if (up > down && up > 0) up else 0.0
            val m = if (down > up && down > 0) down else 0.0
            val t = max(h[i] - l[i], max(abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
            if (i <= n) {
                tr += t; pdm += p; mdm += m
                if (i < n) continue
            } else {
                tr = tr - tr / n + t; pdm = pdm - pdm / n + p; mdm = mdm - mdm / n + m
            }
            if (tr <= 0) continue
            pdi[i] = 100 * pdm / tr
            mdi[i] = 100 * mdm / tr
            val s = pdi[i] + mdi[i]
            dx[i] = if (s > 0) 100 * abs(pdi[i] - mdi[i]) / s else 0.0
        }
        var a = 0.0
        var count = 0
        for (i in n until size) {
            if (dx[i].isNaN()) continue
            if (count < n) {
                a += dx[i]
                count++
                if (count == n) {
                    a /= n
                    adx[i] = a
                }
            } else {
                a = (a * (n - 1) + dx[i]) / n
                adx[i] = a
            }
        }
        return Adx(adx, pdi, mdi)
    }

    /** Bollinger(n, k) width relative to the middle band: 2 k sd / SMA (population sd). */
    fun bollingerWidth(close: DoubleArray, n: Int = 20, k: Double = 2.0): DoubleArray {
        val out = DoubleArray(close.size) { Double.NaN }
        var sum = 0.0
        var sum2 = 0.0
        for (i in close.indices) {
            sum += close[i]
            sum2 += close[i] * close[i]
            if (i >= n) {
                sum -= close[i - n]
                sum2 -= close[i - n] * close[i - n]
            }
            if (i >= n - 1) {
                val m = sum / n
                val v = (sum2 / n - m * m).coerceAtLeast(0.0)
                out[i] = if (m > 0) 2 * k * sqrt(v) / m else Double.NaN
            }
        }
        return out
    }

    /** Fraction of the values in [from, to) that are <= x (NaN values ignored); NaN if fewer than [min] values. */
    fun percentile(values: DoubleArray, from: Int, to: Int, x: Double, min: Int = 20): Double {
        var n = 0
        var le = 0
        for (j in maxOf(0, from) until minOf(to, values.size)) {
            val v = values[j]
            if (v.isNaN()) continue
            n++
            if (v <= x) le++
        }
        return if (n < min) Double.NaN else le.toDouble() / n
    }
}
