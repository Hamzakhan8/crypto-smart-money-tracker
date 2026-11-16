package com.smartmoney.screener.data

import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.InstrumentKey
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe

/**
 * Live paper results of v0.3 signals, scored the same way as the backtest plan: target and stop 1 ATR from the
 * entry, close after 30 minutes. Uses closed candles only; target and stop inside one candle = stop (conservative).
 */
object Paper {
    const val HORIZON_MS = 30 * 60_000L
    /** Spread estimate added to the two taker fees (the backtest's average spread + slippage at $1,000 was about this). */
    const val SPREAD_ESTIMATE = 0.0002

    /** v0.2 base rule, Binance perps backtest 2025-01 to 2026-06 (docs/results/phase3-baselines.md, trial 3). */
    const val BACKTEST_WIN_RATE = 0.482
    const val BACKTEST_NET = -0.00116
    const val BACKTEST_EVENTS = 23_564
    const val MIN_FOR_VERDICT = 30

    class Result(val status: String, val exit: Double, val net: Double)

    /**
     * Result of a signal that closed at [signalClose] with [entry], [target], [stop] in direction [dir] (+1 long, -1
     * short), from [candles] of length [tfMs]. Null while the 30 minutes are not over or the candles are not there yet.
     */
    fun evaluate(candles: List<Candle>, tfMs: Long, signalClose: Long, entry: Double, target: Double, stop: Double, dir: Int, costs: Double, now: Long): Result? {
        val end = signalClose + HORIZON_MS
        val window = candles.filter { it.closed && it.openTime >= signalClose && it.openTime < end }.sortedBy { it.openTime }
        fun result(status: String, exit: Double) = Result(status, exit, dir * (exit / entry - 1) - costs)
        for (c in window) {
            val hitStop = if (dir == 1) c.low <= stop else c.high >= stop
            val hitTarget = if (dir == 1) c.high >= target else c.low <= target
            if (hitStop) return result("LOSS", stop)
            if (hitTarget) return result("WIN", target)
        }
        val last = window.lastOrNull() ?: return null
        if (now < end || last.openTime + tfMs < end) return null
        return result("TIMEOUT", last.close)
    }

    class Summary(val n: Int, val winRate: Double, val avgNet: Double) {
        /** Decay flag against the v0.2 backtest; null when there is nothing to flag. */
        val verdict: String?
            get() = when {
                n < MIN_FOR_VERDICT -> "Too few results to judge yet ($n of $MIN_FOR_VERDICT)"
                winRate < BACKTEST_WIN_RATE - 0.10 || avgNet < BACKTEST_NET - 0.002 -> "Worse than the backtest: decaying"
                else -> null
            }
    }

    fun summarize(rows: List<HitEntity>): Summary {
        val done = rows.filter { it.paperNet != null }
        if (done.isEmpty()) return Summary(0, Double.NaN, Double.NaN)
        return Summary(done.size, done.count { it.paperStatus == "WIN" }.toDouble() / done.size, done.mapNotNull { it.paperNet }.average())
    }

    /** Scores every open v0.3 signal that can be scored now; marks ones that cannot be followed as UNTRACKED. */
    suspend fun update(dao: HistoryDao, candlesOf: suspend (InstrumentKey) -> List<Candle>, tf: Timeframe, fees: (Exchange, Market) -> Double, now: Long) {
        for (h in dao.openPaper(now - 24 * 3_600_000L)) {
            val exchange = Exchange.entries.firstOrNull { it.name == h.exchange } ?: continue
            val market = Market.entries.firstOrNull { it.name == h.market } ?: continue
            val target = h.target ?: continue
            val stop = h.stop ?: continue
            val hitTf = Timeframe.fromLabel(h.timeframe) ?: tf
            val signalClose = h.candleOpenTime + hitTf.millis
            val dir = if (h.label == "SHORT") -1 else 1
            val r = evaluate(candlesOf(InstrumentKey(exchange, market, h.canonical)), tf.millis, signalClose, h.price, target, stop, dir,
                2 * fees(exchange, market) + SPREAD_ESTIMATE, now)
            when {
                r != null -> dao.setPaper(h.id, r.status, r.net, r.exit)
                now > signalClose + HORIZON_MS + 3 * 3_600_000L -> dao.setPaper(h.id, "UNTRACKED", null, null)
            }
        }
    }
}
