package com.smartmoney.engine.model

/**
 * One normalized model for every exchange. Rule: a metric an exchange does not provide is null, never zero.
 */
enum class Exchange(val label: String) { BINANCE("Binance"), BYBIT("Bybit"), OKX("OKX") }

enum class Market(val label: String) { SPOT("Spot"), PERP("Perp") }

enum class Timeframe(val label: String, val millis: Long) {
    M1("1m", 60_000L),
    M5("5m", 300_000L),
    M15("15m", 900_000L),
    H1("1h", 3_600_000L);

    /** Open time of the candle that contains [time]. */
    fun floor(time: Long): Long = time - Math.floorMod(time, millis)

    companion object {
        fun fromLabel(label: String): Timeframe? = entries.firstOrNull { it.label == label }
    }
}

/** Identifies one market on one exchange, for example Binance / PERP / BTC/USDT. */
data class InstrumentKey(val exchange: Exchange, val market: Market, val canonical: String) {
    override fun toString(): String = "${exchange.label} ${market.label} $canonical"
}

/** Feed = one exchange + one market (each has its own connection). */
data class FeedId(val exchange: Exchange, val market: Market) {
    override fun toString(): String = "${exchange.label} ${market.label}"
}

data class Instrument(
    val exchange: Exchange,
    val market: Market,
    /** The exchange's own name: BTCUSDT (Binance, Bybit) or BTC-USDT / BTC-USDT-SWAP (OKX). */
    val nativeSymbol: String,
    val base: String,
    val quote: String,
    /** False for halted, delisting, pre-launch or settling markets. */
    val trading: Boolean,
    /** Base units per contract (OKX swaps). Null when sizes are already in base units. */
    val contractValue: Double? = null,
    /**
     * How many coins one unit of this market's price is for. 1000 for perps named 1000PEPE (price of 1,000 PEPE); [base]
     * is then "PEPE". Divide the native price by this to compare across exchanges.
     */
    val priceMultiplier: Double = 1.0,
) {
    val canonical: String get() = "$base/$quote"
    val key: InstrumentKey get() = InstrumentKey(exchange, market, canonical)
    val feed: FeedId get() = FeedId(exchange, market)
}

/**
 * One candle. [openTime] is the start of the period (UTC millis); the candle covers [openTime, openTime + timeframe).
 * [closed] is true only when the exchange has marked the candle final.
 */
data class Candle(
    val openTime: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val baseVolume: Double,
    /** Volume in the quote currency (USDT). Null if the exchange does not give it. */
    val quoteVolume: Double?,
    /** Quote volume bought by takers (Binance only). */
    val takerBuyQuote: Double? = null,
    /** Number of trades (Binance only). */
    val trades: Long? = null,
    val closed: Boolean,
)

data class Ticker(
    /** The exchange's own symbol, matching [Instrument.nativeSymbol]. */
    val nativeSymbol: String,
    val last: Double,
    val bid: Double?,
    val ask: Double?,
    val quoteVolume24h: Double?,
    val change24hPct: Double?,
    /** Perps only. */
    val markPrice: Double? = null,
    /** Perps only: the current funding rate as a fraction (0.0001 = 0.01%) per funding interval. */
    val fundingRate: Double? = null,
    val nextFundingTime: Long? = null,
    /** Perps only: open interest in base units, when the ticker carries it. */
    val openInterest: Double? = null,
    val time: Long,
) {
    /** Bid-ask spread as a fraction of the mid price. */
    val spread: Double?
        get() {
            val b = bid ?: return null
            val a = ask ?: return null
            if (b <= 0.0 || a <= 0.0 || a < b) return null
            return (a - b) / ((a + b) / 2.0)
        }
}

/** Open interest at [time], in base units (coins). */
data class OpenInterestPoint(val time: Long, val openInterest: Double)

data class BookLevel(val price: Double, val size: Double)

data class OrderBook(val bids: List<BookLevel>, val asks: List<BookLevel>, val time: Long)

data class FundingPoint(val time: Long, val rate: Double)
