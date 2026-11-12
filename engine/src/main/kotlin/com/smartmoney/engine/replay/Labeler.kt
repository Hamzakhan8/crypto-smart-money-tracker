package com.smartmoney.engine.replay

/** Entry delay after the signal (pre-registration L1). 2 minutes is the primary assumption. */
enum class Delay(val label: String) { D0("0s"), D30("30s"), D2M("2m"), D5M("5m") }

enum class Status { WIN, LOSS, TIMEOUT, INVALID }

/**
 * One labeled trade. [gross] is the direction-adjusted return (exit / entry - 1, times -1 for shorts).
 * Times are minute open times; [exitEnd] is the end of the exit minute.
 */
data class Outcome(
    val status: Status,
    val entryTime: Long = 0,
    val entryPrice: Double = Double.NaN,
    val exitMinute: Long = 0,
    val exitPrice: Double = Double.NaN,
    val gross: Double = Double.NaN,
    val ambiguous: Boolean = false,
    val mfe: Double = Double.NaN,
    val mae: Double = Double.NaN,
    val minutesToPeak: Int = -1,
) {
    val exitEnd: Long get() = exitMinute + MINUTE
}

/**
 * Triple-barrier labeler on 1m candles (pre-registration L1): barriers at entry +- [width] (price units), horizon
 * [horizon] minutes. The first barrier hit decides; both inside one candle counts as a loss (order unknown); any
 * missing minute in the window makes the label INVALID.
 */
object Labeler {
    const val HORIZON = 30

    fun label(m: Minutes, signalTime: Long, dir: Int, width: Double, delay: Delay, horizon: Int = HORIZON): Outcome {
        require(dir == 1 || dir == -1)
        if (!(width > 0) || !width.isFinite()) return Outcome(Status.INVALID)
        val entryPrice: Double
        val entryTime: Long
        val first: Int
        when (delay) {
            Delay.D30 -> {
                // A fill somewhere in the first minute: its VWAP. Barriers are checked from the next minute on.
                val i = m.idx(signalTime)
                if (i < 0 || m.v[i] <= 0.0) return Outcome(Status.INVALID)
                entryPrice = m.qv[i] / m.v[i]
                entryTime = signalTime + 30_000
                first = m.idx(signalTime + MINUTE)
            }
            else -> {
                val at = signalTime + when (delay) {
                    Delay.D0 -> 0L
                    Delay.D2M -> 2 * MINUTE
                    else -> 5 * MINUTE
                }
                first = m.idx(at)
                if (first < 0) return Outcome(Status.INVALID)
                entryPrice = m.o[first]
                entryTime = at
            }
        }
        if (first < 0 || !m.contiguous(first, horizon) || !(entryPrice > 0)) return Outcome(Status.INVALID)
        val up = entryPrice + width
        val down = entryPrice - width
        var mfe = 0.0
        var mae = 0.0
        var peakAt = 0
        for (k in 0 until horizon) {
            val i = first + k
            val fav = if (dir == 1) m.h[i] / entryPrice - 1 else 1 - m.l[i] / entryPrice
            val adv = if (dir == 1) 1 - m.l[i] / entryPrice else m.h[i] / entryPrice - 1
            if (fav > mfe) { mfe = fav; peakAt = k }
            if (adv > mae) mae = adv
            val hitUp = m.h[i] >= up
            val hitDown = m.l[i] <= down
            if (hitUp && hitDown) {
                val exit = if (dir == 1) down else up
                return Outcome(Status.LOSS, entryTime, entryPrice, m.t[i], exit, dir * (exit / entryPrice - 1), true, mfe, mae, peakAt)
            }
            val win = if (dir == 1) hitUp else hitDown
            val loss = if (dir == 1) hitDown else hitUp
            if (win) {
                val exit = if (dir == 1) up else down
                return Outcome(Status.WIN, entryTime, entryPrice, m.t[i], exit, dir * (exit / entryPrice - 1), false, mfe, mae, peakAt)
            }
            if (loss) {
                val exit = if (dir == 1) down else up
                return Outcome(Status.LOSS, entryTime, entryPrice, m.t[i], exit, dir * (exit / entryPrice - 1), false, mfe, mae, peakAt)
            }
        }
        val last = first + horizon - 1
        return Outcome(Status.TIMEOUT, entryTime, entryPrice, m.t[last], m.c[last], dir * (m.c[last] / entryPrice - 1), false, mfe, mae, peakAt)
    }
}
