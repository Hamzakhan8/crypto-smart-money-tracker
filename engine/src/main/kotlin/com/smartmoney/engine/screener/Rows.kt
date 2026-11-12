package com.smartmoney.engine.screener

import com.smartmoney.engine.features.Breakout
import com.smartmoney.engine.features.CandleSeries
import com.smartmoney.engine.features.DepthInfo
import com.smartmoney.engine.features.FeatureSet
import com.smartmoney.engine.features.Features
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Instrument
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.OpenInterestPoint
import com.smartmoney.engine.model.Ticker
import com.smartmoney.engine.model.Timeframe
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max

/**
 * Track A tiers. Watch = unusual move in a candle still in progress. Confirmed = the candle closed with an unusual
 * move and every gate passed. Rejected = closed with an unusual move but a gate failed (logged with the reason).
 * There is no "Actionable" tier in Track A: nothing here has been validated, so every row is "unproven".
 */
enum class Tier(val label: String) { NONE("-"), WATCH("Watch"), CONFIRMED("Confirmed"), REJECTED("Rejected") }

enum class Direction { UP, DOWN }

enum class SignalLabel(val text: String) { PUMP("Pump"), DUMP("Dump"), AVOID("Warning / avoid") }

/** Display labels from price and open interest direction. Not validated. */
enum class Cause(val text: String) {
    NEW_LONGS("New longs (price up, OI up)"),
    SHORT_SQUEEZE("Short squeeze (price up, OI down)"),
    NEW_SHORTS("New shorts (price down, OI up)"),
    LONG_LIQUIDATION("Long liquidation (price down, OI down)"),
}

/** A hard yes/no check. [passed] null = could not be checked, which counts as not passed. */
data class Gate(val name: String, val passed: Boolean?, val detail: String)

data class RiskFlag(val code: String, val text: String)

data class PerpInfo(
    val markPrice: Double?,
    /** last / mark - 1. */
    val markDivergence: Double?,
    val fundingRate: Double?,
    val nextFundingTime: Long?,
    val oiChange: Double?,
    val oiWindowMinutes: Int?,
    val openInterestUsd: Double?,
    val cause: Cause?,
)

data class CrossInfo(
    /** Exchanges with this coin in the same market. */
    val exchangesWithData: Int = 1,
    /** Exchanges showing an unusual move in the same direction now (this one included). */
    val confirmations: Int = 0,
    /** Only this exchange moves while others have the coin. */
    val isolated: Boolean = false,
    /** This price vs the median price on the other exchanges. */
    val priceDeviation: Double? = null,
)

data class ScreenerRow(
    val instrument: Instrument,
    val timeframe: Timeframe,
    val price: Double?,
    val ticker: Ticker?,
    /** Features of the newest closed candle, when it is the latest finished period. */
    val closed: FeatureSet?,
    /** Features of the candle in progress. */
    val live: FeatureSet?,
    val perp: PerpInfo?,
    val depth: DepthInfo?,
    val tier: Tier,
    val direction: Direction?,
    val label: SignalLabel?,
    val gates: List<Gate>,
    val flags: List<RiskFlag>,
    /** Where the move's thesis fails: the signal candle's low (up moves) or high (down moves). */
    val invalidation: Double?,
    val cross: CrossInfo,
    val reason: String,
    val mainRisk: String,
) {
    /** Track A: nothing is validated. */
    val unproven: Boolean get() = true

    /** Features the tier is based on. */
    val focus: FeatureSet? get() = if (tier == Tier.WATCH) live else closed ?: live
}

object RowBuilder {
    const val LOW_LIQUIDITY_USD = 20_000_000.0
    const val EXTREME_FUNDING = 0.001
    const val MARK_DIVERGENCE = 0.005
    const val PRICE_MISMATCH = 0.01
    const val FEW_TRADES = 50L
    const val THIN_BURST_RELVOL = 5.0
    const val OI_DEADBAND = 0.001
    const val DEPTH_MAX_AGE_MS = 3 * 60_000L

    fun build(
        inst: Instrument,
        series: CandleSeries?,
        btc: Map<Long, Candle>?,
        ticker: Ticker?,
        oi: List<OpenInterestPoint>?,
        depth: DepthInfo?,
        config: EngineConfig,
        now: Long,
    ): ScreenerRow {
        val tf = config.timeframe
        val candles = series?.candles ?: emptyList()
        val lastClosedIdx = candles.indexOfLast { it.closed }
        val closedAll = if (lastClosedIdx >= 0) Features.compute(candles, lastClosedIdx, tf, btc) else null
        val closed = closedAll?.takeIf { it.candleOpenTime >= tf.floor(now) - tf.millis }
        val live = if (candles.isNotEmpty() && !candles.last().closed) Features.compute(candles, candles.size - 1, tf, btc) else null
        val price = ticker?.last ?: candles.lastOrNull()?.close
        val thr = config.moveThresholdZ

        val signal = closed?.takeIf { f -> f.zMove?.let { abs(it) >= thr } == true }
        val watch = if (signal == null) live?.takeIf { f -> f.zMove?.let { abs(it) >= thr } == true } else null
        val focus = signal ?: watch ?: closed ?: live
        val direction = focus?.move?.let { if (it > 0) Direction.UP else if (it < 0) Direction.DOWN else null }

        val freshDepth = depth?.takeIf { now - it.time <= DEPTH_MAX_AGE_MS }
        val perp = if (inst.market == Market.PERP) perpInfo(ticker, oi, focus, tf, price, now) else null
        val gates = gates(inst, ticker, freshDepth, focus, direction, config)
        val allPassed = gates.all { it.passed == true }

        val tier = when {
            signal != null && allPassed -> Tier.CONFIRMED
            signal != null -> Tier.REJECTED
            watch != null -> Tier.WATCH
            else -> Tier.NONE
        }
        val label = if (tier == Tier.NONE || direction == null) null else when (direction) {
            Direction.UP -> SignalLabel.PUMP
            Direction.DOWN -> if (config.canShort) SignalLabel.DUMP else SignalLabel.AVOID
        }
        val invalidation = if (tier == Tier.NONE) null else when (direction) {
            Direction.UP -> focus?.low
            Direction.DOWN -> focus?.high
            null -> null
        }
        val flags = flags(ticker, focus, perp, freshDepth, config, tier != Tier.NONE)
        return ScreenerRow(
            instrument = inst, timeframe = tf, price = price, ticker = ticker, closed = closed, live = live, perp = perp,
            depth = freshDepth, tier = tier, direction = direction, label = label, gates = gates, flags = flags,
            invalidation = invalidation, cross = CrossInfo(), reason = reason(focus, tier, perp, tf), mainRisk = mainRisk(tier, gates, flags),
        )
    }

    /** Adds cross-exchange confirmation, price sanity and the "isolated" flag across all rows of one snapshot. */
    fun applyCross(rows: List<ScreenerRow>): List<ScreenerRow> {
        val groups = rows.groupBy { it.instrument.market to it.instrument.canonical }
        return rows.map { row ->
            val group = groups[row.instrument.market to row.instrument.canonical].orEmpty()
            val others = group.filter { it.instrument.exchange != row.instrument.exchange }
            // Compare per-coin prices: a 1000PEPE contract's price is for 1,000 coins.
            val otherPrices = others.mapNotNull { o -> o.price?.let { it / o.instrument.priceMultiplier } }.filter { it > 0 }
            val own = row.price?.let { it / row.instrument.priceMultiplier }
            val deviation = if (own != null && otherPrices.isNotEmpty()) own / Features.median(otherPrices) - 1 else null
            val movers = group.filter { it.tier != Tier.NONE && it.direction != null && it.direction == row.direction }
            val confirmations = if (row.tier == Tier.NONE) 0 else movers.map { it.instrument.exchange }.distinct().size
            val isolated = row.tier != Tier.NONE && confirmations == 1 && others.isNotEmpty()
            val extra = buildList {
                if (deviation != null && abs(deviation) > PRICE_MISMATCH) {
                    add(RiskFlag("PRICE_MISMATCH", "Price ${pct(deviation)} away from other exchanges: this feed may be stale or thin"))
                }
                if (isolated) add(RiskFlag("ISOLATED", "Isolated: only ${row.instrument.exchange.label} shows this move"))
            }
            if (extra.isEmpty() && others.isEmpty()) row.copy(cross = CrossInfo(1, confirmations, false, null))
            else {
                val flags = row.flags + extra
                row.copy(
                    cross = CrossInfo(group.map { it.instrument.exchange }.distinct().size, confirmations, isolated, deviation),
                    flags = flags,
                    mainRisk = mainRisk(row.tier, row.gates, flags),
                )
            }
        }
    }

    private fun perpInfo(ticker: Ticker?, oi: List<OpenInterestPoint>?, focus: FeatureSet?, tf: Timeframe, price: Double?, now: Long): PerpInfo {
        val mark = ticker?.markPrice
        val last = ticker?.last
        val div = if (mark != null && last != null && mark > 0) last / mark - 1 else null
        var oiChange: Double? = null
        var windowMin: Int? = null
        if (!oi.isNullOrEmpty() && focus != null) {
            val window = max(tf.millis, 5 * 60_000L)
            val end = minOf(focus.candleOpenTime + tf.millis, now)
            val endPt = oi.lastOrNull { it.time <= end }?.takeIf { end - it.time <= 10 * 60_000L }
            val startPt = endPt?.let { e -> oi.lastOrNull { it.time <= e.time - window } }
            if (endPt != null && startPt != null && startPt.openInterest > 0) {
                oiChange = endPt.openInterest / startPt.openInterest - 1
                windowMin = ((endPt.time - startPt.time) / 60_000L).toInt()
            }
        }
        val latestOi = oi?.lastOrNull()?.openInterest ?: ticker?.openInterest
        val oiUsd = if (latestOi != null && price != null) latestOi * price else null
        val move = focus?.move
        val cause = if (move == null || oiChange == null || abs(oiChange) < OI_DEADBAND || move == 0.0) null else when {
            move > 0 && oiChange > 0 -> Cause.NEW_LONGS
            move > 0 -> Cause.SHORT_SQUEEZE
            oiChange > 0 -> Cause.NEW_SHORTS
            else -> Cause.LONG_LIQUIDATION
        }
        return PerpInfo(mark, div, ticker?.fundingRate, ticker?.nextFundingTime, oiChange, windowMin, oiUsd, cause)
    }

    private fun gates(inst: Instrument, ticker: Ticker?, depth: DepthInfo?, focus: FeatureSet?, direction: Direction?, cfg: EngineConfig): List<Gate> {
        val vol = ticker?.quoteVolume24h
        val spread = depth?.spread ?: ticker?.spread
        val slip = depth?.let { d -> if (direction == Direction.DOWN) d.sellSlippage[cfg.tradeSizeUsd] else d.buySlippage[cfg.tradeSizeUsd] }
        val sizeText = usd(cfg.tradeSizeUsd)
        val fee = cfg.takerFee(inst.exchange, inst.market)
        val cost = if (spread != null && slip != null) 2 * fee + spread + 2 * slip else null
        val atr = focus?.atrPct
        return listOf(
            Gate("Trading", inst.trading, if (inst.trading) "Market is open for trading" else "Not trading (halted, delisting, pre-launch or settling)"),
            Gate(
                "24h volume", vol?.let { it >= cfg.minQuoteVolume24h },
                if (vol == null) "24h volume n/a" else "24h volume ${usd(vol)} (min ${usd(cfg.minQuoteVolume24h)})",
            ),
            Gate(
                "Spread", spread?.let { it <= cfg.maxSpread },
                if (spread == null) "Spread n/a" else "Spread ${pct(spread, signed = false)} (max ${pct(cfg.maxSpread, signed = false)})",
            ),
            Gate(
                "Clean data", focus?.let { it.dataIssues.isEmpty() && it.history > Features.ATR_LEN },
                when {
                    focus == null -> "No candles yet"
                    focus.dataIssues.isNotEmpty() -> "Data problem: ${focus.dataIssues.joinToString(", ")}"
                    focus.history <= Features.ATR_LEN -> "Only ${focus.history} candles of history (need ${Features.ATR_LEN + 1})"
                    else -> "No gaps, duplicates, bad timestamps or bad prints in the last ${minOf(focus.history, Features.BASELINE_LEN)} candles"
                },
            ),
            Gate(
                "Depth", if (depth == null) null else slip?.let { it <= cfg.maxSlippage } ?: false,
                when {
                    depth == null -> "Order book not checked (it is checked when a candle closes with an unusual move)"
                    slip == null -> "Visible order book cannot fill $sizeText"
                    else -> "Est. slippage for a $sizeText ${if (direction == Direction.DOWN) "sell" else "buy"}: ${pct(slip, signed = false)} (max ${pct(cfg.maxSlippage, signed = false)})"
                },
            ),
            Gate(
                "Move vs costs", if (cost == null || atr == null) null else atr >= cfg.costMultiple * cost,
                if (cost == null || atr == null) "Cost check needs the order book and ATR"
                else "Typical candle range ${pct(atr, signed = false)} vs round-trip cost ${pct(cost, signed = false)} (fees ${pct(2 * fee, signed = false)} + spread + slippage; needs ${fmt1(cfg.costMultiple)}x)",
            ),
        )
    }

    private fun flags(ticker: Ticker?, focus: FeatureSet?, perp: PerpInfo?, depth: DepthInfo?, cfg: EngineConfig, moving: Boolean): List<RiskFlag> = buildList {
        val vol = ticker?.quoteVolume24h
        if (vol != null && vol < LOW_LIQUIDITY_USD) add(RiskFlag("LOW_LIQUIDITY", "Low liquidity: 24h volume ${usd(vol)}; small coins are easier to push around"))
        val rv = focus?.relVolume
        val spread = depth?.spread ?: ticker?.spread
        if (rv != null && rv >= THIN_BURST_RELVOL) {
            val thinDepth = depth?.let { minOf(it.bidUsdWithin1, it.askUsdWithin1) < 10 * cfg.tradeSizeUsd } ?: false
            if (thinDepth || (spread != null && spread > 0.001)) add(RiskFlag("THIN_BURST", "Volume burst (${fmt1(rv)}x) on a thin order book"))
        }
        perp?.fundingRate?.let { if (abs(it) >= EXTREME_FUNDING) add(RiskFlag("EXTREME_FUNDING", "Extreme funding ${pct(it, digits = 3)} per interval")) }
        perp?.markDivergence?.let { if (abs(it) > MARK_DIVERGENCE) add(RiskFlag("MARK_DIVERGENCE", "Last price ${pct(it)} away from mark price")) }
        val trades = focus?.trades
        if (moving && trades != null && trades < FEW_TRADES) add(RiskFlag("FEW_TRADES", "Price moved on only $trades trades"))
    }

    fun mainRisk(tier: Tier, gates: List<Gate>, flags: List<RiskFlag>): String {
        val failed = gates.firstOrNull { it.passed != true }
        if (tier == Tier.REJECTED && failed != null) return "Rejected: ${failed.detail}"
        flags.firstOrNull()?.let { return it.text }
        return "Unproven: this move type has not been validated; most single-candle moves fade"
    }

    private fun reason(f: FeatureSet?, tier: Tier, perp: PerpInfo?, tf: Timeframe): String {
        if (f == null) return "Waiting for ${tf.label} candles"
        val move = f.move ?: return "Not enough candles yet for ${tf.label} features"
        val parts = ArrayList<String>()
        val head = if (f.closed) "${tf.label} candle closed ${pct(move)}" else "${tf.label} candle in progress: ${pct(move)} so far"
        parts += head + (f.zMove?.let { " (${fmt1(abs(it))}x its usual range)" } ?: "")
        f.relVolume?.let { parts += "volume ${fmt1(it)}x its recent median" }
        f.residual?.let { parts += "BTC-adjusted ${pct(it)}" }
        when (f.breakout) {
            Breakout.UP -> parts += "above its ${Features.BREAKOUT_LEN}-candle high"
            Breakout.DOWN -> parts += "below its ${Features.BREAKOUT_LEN}-candle low"
            else -> Unit
        }
        f.closeLocation?.let { parts += "${if (f.closed) "closed" else "trading"} at ${(it * 100).toInt()}% of its range" }
        f.takerImbalance?.let { parts += "takers ${((it + 1) / 2 * 100).toInt()}% buyers" }
        if (perp != null) {
            perp.oiChange?.let { parts += "open interest ${pct(it)} in ${perp.oiWindowMinutes ?: 5}m" + (perp.cause?.let { c -> " (${c.text.substringBefore(" (")})" } ?: "") }
            perp.fundingRate?.let { parts += "funding ${pct(it, digits = 3)}" }
        }
        val text = parts.joinToString("; ")
        return if (tier == Tier.NONE) "No unusual move. $text" else text
    }

    fun pct(x: Double, signed: Boolean = true, digits: Int = 2): String {
        val s = String.format(Locale.US, "%.${digits}f%%", x * 100)
        return if (signed && x > 0) "+$s" else s
    }

    fun fmt1(x: Double): String = String.format(Locale.US, "%.1f", x)

    fun usd(x: Double): String = when {
        x >= 1e9 -> String.format(Locale.US, "$%.2fB", x / 1e9)
        x >= 1e6 -> String.format(Locale.US, "$%.1fM", x / 1e6)
        x >= 1e3 -> String.format(Locale.US, "$%,.0f", x)
        else -> String.format(Locale.US, "$%.2f", x)
    }
}
