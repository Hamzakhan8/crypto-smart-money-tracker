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

/**
 * The action a signal points to. Perps: LONG after an up move, SHORT after a down move (shorts can be switched off).
 * Spot: BUY after an up move only; a spot coin that is falling gets no action. None of these is validated yet.
 */
enum class SignalLabel(val text: String) { LONG("LONG"), SHORT("SHORT"), BUY("BUY") }

/**
 * The plan the Replay Lab measures (pre-registration L1): target and stop 1 ATR from the entry, close after
 * [horizonMinutes]. Shown with every signal so the user sees exactly what is being tested.
 */
data class TradePlan(val entry: Double, val target: Double, val stop: Double, val horizonMinutes: Int = 30)

/** Display labels from price and open interest direction. Not validated. */
enum class Cause(val text: String) {
    NEW_LONGS("New longs (price up, OI up)"),
    SHORT_SQUEEZE("Short squeeze (price up, OI down)"),
    NEW_SHORTS("New shorts (price down, OI up)"),
    LONG_LIQUIDATION("Long liquidation (price down, OI down)"),
}

/** A hard yes/no check. [passed] null = could not be checked, which counts as not passed. */
data class Gate(val name: String, val passed: Boolean?, val detail: String)

/** A v0.3 confirmation. [passed] null = not available (left out of the score). */
data class Check(val name: String, val passed: Boolean?, val detail: String)

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
    /** Entry, target and stop for rows with an action (LONG, SHORT, BUY). */
    val plan: TradePlan?,
    val cross: CrossInfo,
    val reason: String,
    val mainRisk: String,
    /** v0.3 confirmation checks (passed null = not available for this coin / market). */
    val checks: List<Check> = emptyList(),
    /** Share of available checks that pass, 0-100; null with fewer than 4 available. Equal weights, not validated. */
    val score: Int? = null,
    /** Shown as a signal: confirmed move with an action and score >= the minimum score. */
    val isSignal: Boolean = false,
) {
    /** Nothing is validated yet: v0.3 signals are EXPERIMENTAL. */
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
        /** EMA50 of 1h and of 4h closes (closed candles), when known. */
        htf: Pair<Double?, Double?>? = null,
        /** BTC's move over about the last 15 minutes on the same exchange and market. */
        btcMove15: Double? = null,
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
        val label = if (tier == Tier.NONE || direction == null) null else when (inst.market) {
            Market.PERP -> if (direction == Direction.UP) SignalLabel.LONG else if (config.canShort) SignalLabel.SHORT else null
            Market.SPOT -> if (direction == Direction.UP) SignalLabel.BUY else null
        }
        val invalidation = if (tier == Tier.NONE) null else when (direction) {
            Direction.UP -> focus?.low
            Direction.DOWN -> focus?.high
            null -> null
        }
        val plan = if (label == null || price == null) null else focus?.atrPct?.let { atr ->
            val width = atr * price
            val sign = if (label == SignalLabel.SHORT) -1 else 1
            TradePlan(entry = price, target = price + sign * width, stop = price - sign * width)
        }
        val flags = flags(ticker, focus, perp, freshDepth, config, tier != Tier.NONE)
        val checks = if (direction == null || price == null) emptyList() else checks(inst, focus, perp, price, if (direction == Direction.UP) 1 else -1, htf, btcMove15)
        val available = checks.filter { it.passed != null }
        val score = if (available.size < MIN_CHECKS) null else Math.round(100.0 * available.count { it.passed == true } / available.size).toInt()
        return ScreenerRow(
            instrument = inst, timeframe = tf, price = price, ticker = ticker, closed = closed, live = live, perp = perp,
            depth = freshDepth, tier = tier, direction = direction, label = label, gates = gates, flags = flags,
            invalidation = invalidation, plan = plan, cross = CrossInfo(), reason = reason(focus, tier, perp, tf), mainRisk = mainRisk(tier, gates, flags),
            checks = checks, score = score,
            isSignal = tier == Tier.CONFIRMED && label != null && score != null && score >= config.minScore,
        )
    }

    const val MIN_CHECKS = 4

    /**
     * The v0.3 priority confirmations that can be computed live (user spec 2a), for direction [d]. Equal weights: no
     * backtest has set weights yet. passed = null when the data is not available.
     */
    fun checks(inst: Instrument, f: FeatureSet?, perp: PerpInfo?, price: Double, d: Int, htf: Pair<Double?, Double?>?, btcMove15: Double?): List<Check> {
        val e1 = htf?.first
        val e4 = htf?.second
        val trend = if (e1 == null || e4 == null) Check("1h + 4h trend (EMA50)", null, "not loaded yet")
        else Check("1h + 4h trend (EMA50)", d * (price - e1) > 0 && d * (price - e4) > 0, "price ${if (d * (price - e1) > 0) "on" else "against"} the 1h EMA50, ${if (d * (price - e4) > 0) "on" else "against"} the 4h EMA50")
        val btc = when {
            inst.base == "BTC" -> Check("BTC not against", true, "this is BTC")
            btcMove15 == null -> Check("BTC not against", null, "BTC data n/a")
            else -> Check("BTC not against", d * btcMove15 >= 0, "BTC ${pct(btcMove15)} in about 15 min")
        }
        val rv = f?.relVolume
        val vol = Check("Volume >= 2x usual", rv?.let { it >= 2.0 }, rv?.let { "volume ${fmt1(it)}x its recent median" } ?: "n/a")
        val tb = f?.takerImbalance?.let { (it + 1) / 2 }
        val taker = Check("Taker flow >= 55%", tb?.let { if (d == 1) it >= 0.55 else it <= 0.45 }, tb?.let { "${(it * 100).toInt()}% of volume bought by takers" } ?: "not given by this exchange")
        val oi = perp?.oiChange
        val oiCheck = Check("Open interest rising", if (perp == null) null else oi?.let { it > 0 }, if (perp == null) "spot: no open interest" else oi?.let { "open interest ${pct(it)}" } ?: "n/a")
        val fr = perp?.fundingRate
        val funding = Check("Funding not crowded", if (perp == null) null else fr?.let { d * it < 0.0005 }, if (perp == null) "spot: no funding" else fr?.let { "funding ${pct(it, digits = 3)}" } ?: "n/a")
        val br = f?.breakout
        val breakout = Check("Range breakout (20 candles)", br?.let { if (d == 1) it == Breakout.UP else it == Breakout.DOWN }, when (br) {
            Breakout.UP -> "above the 20-candle high"; Breakout.DOWN -> "below the 20-candle low"; Breakout.NONE -> "inside the range"; null -> "n/a"
        })
        val cl = f?.closeLocation
        val close = Check("Strong close (top/bottom 25%)", cl?.let { if (d == 1) it >= 0.75 else it <= 0.25 }, cl?.let { "closed at ${(it * 100).toInt()}% of its range" } ?: "n/a")
        return listOf(trend, btc, vol, taker, oiCheck, funding, breakout, close)
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
