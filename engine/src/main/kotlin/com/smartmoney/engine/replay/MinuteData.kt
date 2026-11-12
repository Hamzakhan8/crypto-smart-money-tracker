package com.smartmoney.engine.replay

import com.smartmoney.engine.model.Candle
import java.io.File

const val MINUTE = 60_000L
const val FIVE_MIN = 5 * MINUTE
const val HOUR = 60 * MINUTE
const val DAY = 24 * HOUR

/** Normalizes archive timestamps: Binance switched some archives to microseconds. */
fun archiveMillis(raw: Long): Long = if (raw > 100_000_000_000_000L) raw / 1000 else raw

/** One symbol's 1-minute candles, oldest first, one per minute (gaps are simply absent). */
class Minutes(
    val symbol: String,
    val t: LongArray,
    val o: DoubleArray,
    val h: DoubleArray,
    val l: DoubleArray,
    val c: DoubleArray,
    val v: DoubleArray,
    val qv: DoubleArray,
) {
    val size: Int get() = t.size
    private val cumQv = DoubleArray(t.size + 1).also { for (i in t.indices) it[i + 1] = it[i] + qv[i] }

    /** Index of the minute opening exactly at [time], or -1. */
    fun idx(time: Long): Int {
        val i = java.util.Arrays.binarySearch(t, time)
        return if (i >= 0) i else -1
    }

    /** Index of the first minute opening at or after [time] (may be [size]). */
    fun idxAtOrAfter(time: Long): Int {
        val i = java.util.Arrays.binarySearch(t, time)
        return if (i >= 0) i else -i - 1
    }

    /** Quote volume of the minutes opening in [from, until). */
    fun quoteVolume(from: Long, until: Long): Double = cumQv[idxAtOrAfter(until)] - cumQv[idxAtOrAfter(from)]

    /** True when the minutes [start, start + n) all exist. */
    fun contiguous(startIdx: Int, n: Int): Boolean {
        if (startIdx < 0 || startIdx + n > size) return false
        return t[startIdx + n - 1] - t[startIdx] == (n - 1) * MINUTE
    }

    /** 5-minute bars on UTC boundaries; a bar exists only if all 5 minutes exist. */
    fun bars5m(): List<Candle> {
        val out = ArrayList<Candle>(size / 5 + 1)
        var i = 0
        while (i < size) {
            val open = t[i] - Math.floorMod(t[i], FIVE_MIN)
            if (t[i] == open && i + 4 < size && t[i + 4] == open + 4 * MINUTE) {
                var hi = h[i]
                var lo = l[i]
                var vol = 0.0
                var q = 0.0
                for (k in i until i + 5) {
                    hi = maxOf(hi, h[k]); lo = minOf(lo, l[k]); vol += v[k]; q += qv[k]
                }
                out += Candle(open, o[i], hi, lo, c[i + 4], vol, q, closed = true)
                i += 5
            } else {
                // Skip to the next 5-minute boundary.
                val next = open + FIVE_MIN
                while (i < size && t[i] < next) i++
            }
        }
        return out
    }

    companion object {
        /** Loads 1m kline zips (archive format), merging months and dropping duplicate minutes. */
        fun load(symbol: String, files: List<File>): Minutes {
            val rows = java.util.TreeMap<Long, DoubleArray>()
            for (f in files) {
                Archive.forEachRow(f) { r ->
                    val time = archiveMillis(r[0].toLong())
                    rows[time] = doubleArrayOf(r[1].toDouble(), r[2].toDouble(), r[3].toDouble(), r[4].toDouble(), r[5].toDouble(), r[7].toDouble())
                }
            }
            return fromRows(symbol, rows)
        }

        fun fromRows(symbol: String, rows: java.util.SortedMap<Long, DoubleArray>): Minutes {
            val n = rows.size
            val t = LongArray(n)
            val o = DoubleArray(n)
            val h = DoubleArray(n)
            val l = DoubleArray(n)
            val c = DoubleArray(n)
            val v = DoubleArray(n)
            val q = DoubleArray(n)
            var i = 0
            for ((time, x) in rows) {
                t[i] = time; o[i] = x[0]; h[i] = x[1]; l[i] = x[2]; c[i] = x[3]; v[i] = x[4]; q[i] = x[5]
                i++
            }
            return Minutes(symbol, t, o, h, l, c, v, q)
        }
    }
}
