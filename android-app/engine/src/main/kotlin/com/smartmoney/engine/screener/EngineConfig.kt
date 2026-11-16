package com.smartmoney.engine.screener

import com.smartmoney.engine.exchange.DefaultFees
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe
import java.security.MessageDigest

/** Logged with every screener hit, so every record says which code and settings produced it. */
const val ENGINE_VERSION = "0.3.0-experimental"

data class EngineConfig(
    val timeframe: Timeframe = Timeframe.M5,
    val exchanges: Set<Exchange> = Exchange.entries.toSet(),
    val markets: Set<Market> = Market.entries.toSet(),
    /** Most-traded instruments followed per exchange and market (BTC is always added for the residual move). */
    val universeSize: Int = 40,
    /** Gate: minimum 24h volume in USDT. */
    val minQuoteVolume24h: Double = 5_000_000.0,
    /** Gate: maximum bid-ask spread (fraction of mid). */
    val maxSpread: Double = 0.002,
    /** A candle counts as an unusual move when |move| >= this many ATRs. */
    val moveThresholdZ: Double = 2.0,
    /** Your trade size in USD, used for the slippage and cost gates. */
    val tradeSizeUsd: Double = 1_000.0,
    /** Gate: maximum estimated slippage of a market order of [tradeSizeUsd]. */
    val maxSlippage: Double = 0.003,
    /** Gate: the typical candle range (ATR) must be at least this multiple of the round-trip cost. */
    val costMultiple: Double = 2.0,
    /** Show SHORT signals on perps after down moves. Spot never shows shorts (BUY only). */
    val canShort: Boolean = true,
    /** v0.3: a confirmed move is shown as a signal only with a score at or above this (75 = at least 6 of 8 checks). */
    val minScore: Int = 75,
    /** Taker fee overrides, keyed "BINANCE_SPOT" etc. Missing keys use [DefaultFees]. */
    val takerFees: Map<String, Double> = emptyMap(),
) {
    fun takerFee(exchange: Exchange, market: Market): Double = takerFees["${exchange.name}_${market.name}"] ?: DefaultFees.taker(exchange, market)

    /** Trade sizes for which slippage is computed: the spec's defaults plus yours. */
    val tradeSizes: List<Double> get() = listOf(1_000.0, 10_000.0, tradeSizeUsd).distinct().sorted()

    /** Changes that need the feeds restarted (other changes only re-score). */
    fun needsRestart(other: EngineConfig): Boolean =
        timeframe != other.timeframe || exchanges != other.exchanges || markets != other.markets || universeSize != other.universeSize

    /** Short hash of every setting, logged with each hit. */
    val hash: String by lazy {
        val canonical = listOf(
            "tf=${timeframe.label}", "ex=${exchanges.map { it.name }.sorted()}", "mk=${markets.map { it.name }.sorted()}",
            "n=$universeSize", "vol=$minQuoteVolume24h", "spr=$maxSpread", "z=$moveThresholdZ", "size=$tradeSizeUsd",
            "slip=$maxSlippage", "cost=$costMultiple", "short=$canShort", "minScore=$minScore",
            "fees=${Exchange.entries.flatMap { e -> Market.entries.map { m -> "${e.name}_${m.name}:${takerFee(e, m)}" } }}",
        ).joinToString(";")
        MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray()).joinToString("") { "%02x".format(it) }.take(12)
    }
}
