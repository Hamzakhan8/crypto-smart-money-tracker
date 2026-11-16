package com.smartmoney.engine.exchange

import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Instrument
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.OpenInterestPoint
import com.smartmoney.engine.model.OrderBook
import com.smartmoney.engine.model.Ticker
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.stream.StreamProtocol

/**
 * One exchange, public market data only (no keys, no orders). v1 covers USDT spot pairs and USDT-margined linear
 * perpetuals. Every method throws [com.smartmoney.engine.net.ExchangeException] (or an IOException) on failure.
 */
interface ExchangeAdapter {
    val exchange: Exchange

    /** Most candles one REST request returns. */
    val maxCandlesPerRequest: Int

    /** USDT-quoted spot pairs, or USDT-margined perpetuals, including non-trading ones (marked trading = false). */
    suspend fun instruments(market: Market): List<Instrument>

    /** All tickers of the market in one request where the exchange allows it. Perps include mark and funding. */
    suspend fun tickers(market: Market): List<Ticker>

    /** Candles oldest first. The newest may be in progress (closed = false). [endTime] limits to candles opening at or before it. */
    suspend fun candles(instrument: Instrument, timeframe: Timeframe, limit: Int, endTime: Long? = null): List<Candle>

    /** Perps: open interest every 5 minutes, oldest first, in base units. */
    suspend fun openInterestHistory(instrument: Instrument, limit: Int): List<OpenInterestPoint>

    /** Order book with sizes in base units. */
    suspend fun orderBook(instrument: Instrument): OrderBook

    fun streamProtocol(market: Market): StreamProtocol
}

/**
 * Base-tier taker fees (fraction of notional), used by the cost gate. Editable in the app's Settings.
 * Sources (read 2026-11-12, see docs/DATA_INVENTORY.md): Binance fee schedule page (spot 0.100%) and support FAQ
 * 360033544231 (USD-M 0.05%); Bybit help center fee articles (spot 0.1% non-VIP, some regions higher; USDT perpetual
 * 0.055%); OKX regular tier 0.100% spot / 0.05% perpetual from secondary copies of okx.com/fees (official page did
 * not render for us: not verified).
 */
object DefaultFees {
    fun taker(exchange: Exchange, market: Market): Double = when (exchange) {
        Exchange.BINANCE -> if (market == Market.SPOT) 0.0010 else 0.0005
        Exchange.BYBIT -> if (market == Market.SPOT) 0.0010 else 0.00055
        Exchange.OKX -> if (market == Market.SPOT) 0.0010 else 0.0005
    }
}
