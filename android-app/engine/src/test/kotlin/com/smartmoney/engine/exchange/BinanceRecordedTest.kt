package com.smartmoney.engine.exchange

import com.smartmoney.engine.Fixtures
import com.smartmoney.engine.exchange.BinanceAdapter.Parse
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.stream.StreamEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Binance spot and USD-M, on responses recorded 2026-11-12. */
class BinanceRecordedTest {

    @Test
    fun spotInstrumentsKeepStatusAndNormalizeSymbols() {
        val list = Parse.spotInstruments(Fixtures.json("binance/spot_exchangeInfo_break.json"))
        assertEquals(listOf("BTCUSDT", "ETHUSDT", "EOSUSDT", "WAVESUSDT", "OMGUSDT"), list.map { it.nativeSymbol })
        assertTrue(list.first { it.nativeSymbol == "BTCUSDT" }.trading)
        assertFalse(list.first { it.nativeSymbol == "EOSUSDT" }.trading, "BREAK = delisted from spot, not trading")
        assertEquals("BTC/USDT", list.first().canonical)
    }

    @Test
    fun futuresInstrumentsAreCryptoPerpetualsOnly() {
        val list = Parse.futuresInstruments(Fixtures.json("binance/futures_exchangeInfo.json"))
        // Left out: XAUUSDT and NUUSDT (TRADIFI_PERPETUAL), BTCUSDT_261225 and ETHUSDT_270326 (quarterlies).
        assertEquals(setOf("BTCUSDT", "ETHUSDT", "MKRUSDT", "SOLUSDT", "GAIBUSDT"), list.map { it.nativeSymbol }.toSet())
        assertFalse(list.first { it.nativeSymbol == "MKRUSDT" }.trading, "SETTLING = delisted")
        assertFalse(list.first { it.nativeSymbol == "GAIBUSDT" }.trading, "PENDING_TRADING")
        assertTrue(list.all { it.market == Market.PERP && it.quote == "USDT" })
    }

    @Test
    fun restKlinesMarkOnlyFinishedPeriodsClosed() {
        val j = Fixtures.json("binance/spot_klines_BTCUSDT_5m.json")
        val lastOpen = 1794464400000L
        val during = Parse.klines(j, Timeframe.M5, serverTime = lastOpen + 120_000)
        assertEquals(100, during.size)
        assertEquals(1794434700000L, during.first().openTime)
        assertTrue(during.zipWithNext().all { (a, b) -> b.openTime - a.openTime == 300_000L }, "oldest first, no gaps")
        assertFalse(during.last().closed, "candle still in progress")
        assertTrue(during.dropLast(1).all { it.closed })
        val last = during.last()
        assertEquals(73691.39, last.close)
        assertEquals(676798.3354327, last.quoteVolume!!, 1e-6)
        assertEquals(731L, last.trades)
        assertEquals(653707.2802798, last.takerBuyQuote!!, 1e-6)
        val after = Parse.klines(j, Timeframe.M5, serverTime = lastOpen + 300_000)
        assertTrue(after.last().closed, "closed exactly when its period ends")
    }

    @Test
    fun spotStreamReplayClosesCandlesOnX() {
        val r = Fixtures.replay("binance/spot_ws_kline_1m.jsonl", BinanceAdapter.Stream(Market.SPOT)::parse)
        assertEquals(0, r.malformed)
        assertEquals(63, r.events.size)
        val closed = r.candles.flatMap { u -> u.candles.filter { it.closed }.map { u.nativeSymbol to it } }
        assertEquals(4, closed.size)
        val btc = closed.first { it.first == "BTCUSDT" && it.second.openTime == 1794464640000L }.second
        assertEquals(73733.45, btc.close)
        assertEquals(218977.9182699, btc.quoteVolume!!, 1e-6)
        assertTrue(r.candles.all { it.timeframe == Timeframe.M1 && it.eventTime != null })
        // Merged in arrival order, the final candle is the closed one and later in-progress updates never undo it.
        val series = r.series()
        val merged = series.getValue("BTCUSDT").candles.first { it.openTime == 1794464640000L }
        assertTrue(merged.closed)
        assertEquals(73733.45, merged.close)
        assertTrue(series.getValue("ETHUSDT").candles.all { it.openTime % 60_000L == 0L })
    }

    @Test
    fun futuresStreamReplayOnMarketPath() {
        val r = Fixtures.replay("binance/futures_ws_kline_1m.jsonl", BinanceAdapter.Stream(Market.PERP)::parse)
        assertEquals(0, r.malformed)
        val series = r.series()
        val btc = series.getValue("BTCUSDT").candles.first { it.openTime == 1794464640000L }
        assertTrue(btc.closed)
        assertEquals(73707.20, btc.close)
        assertEquals(3729694.2038, btc.quoteVolume!!, 1e-6)
        assertEquals(2052.79, series.getValue("ETHUSDT").candles.first { it.openTime == 1794464640000L }.close)
        assertEquals("wss://fstream.binance.com/market/stream", BinanceAdapter.Stream(Market.PERP).url)
    }

    @Test
    fun subscribeRepliesAreAcks() {
        val r = Fixtures.replay("binance/spot_ws_subscribe_response.jsonl", BinanceAdapter.Stream(Market.SPOT)::parse)
        assertEquals(0, r.malformed)
        assertTrue(r.events.first() is StreamEvent.Ack)
        assertTrue(r.acks >= 2)
    }

    @Test
    fun subscribeMessagesFollowTheDocs() {
        val msgs = BinanceAdapter.Stream(Market.SPOT).subscribeMessages(listOf("BTCUSDT", "ETHUSDT"), Timeframe.M5)
        assertEquals(listOf("""{"method":"SUBSCRIBE","params":["btcusdt@kline_5m","ethusdt@kline_5m"],"id":1}"""), msgs)
    }

    @Test
    fun futuresTickersMarkFundingAndBook() {
        val prem = Parse.premiumIndex(Fixtures.json("binance/futures_premiumIndex.json")).getValue("BTCUSDT")
        assertEquals(73662.2, prem.mark)
        assertEquals(0.00007783, prem.funding)
        assertEquals(1794470400000L, prem.nextFunding)
        val book = Parse.bookTickers(Fixtures.json("binance/futures_bookTicker.json")).getValue("BTCUSDT")
        assertEquals(73662.2, book.first)
        assertEquals(73662.3, book.second)
        val tickers = Parse.futuresTickers(Fixtures.json("binance/futures_ticker24hr.json"))
        assertTrue(tickers.all { it.bid == null && it.ask == null }, "24hr futures tickers have no bid/ask: null, never 0")
    }

    @Test
    fun spotTickersCarryBidAskAndPercentAsFraction() {
        val t = Parse.spotTickers(Fixtures.json("binance/spot_ticker24hr.json")).first { it.nativeSymbol == "BTCUSDT" }
        assertEquals(73691.39, t.last)
        assertEquals(73691.38, t.bid)
        assertEquals(73691.39, t.ask)
        assertEquals(-0.00258, t.change24hPct!!, 1e-12)
        assertEquals(1042095587.605707, t.quoteVolume24h!!, 1e-3)
    }

    @Test
    fun openInterestHistoryOldestFirst() {
        val pts = Parse.openInterestHist(Fixtures.json("binance/futures_openInterestHist_BTCUSDT_5m.json"))
        assertEquals(100, pts.size)
        assertEquals(1794434700000L, pts.first().time)
        assertEquals(1794464400000L, pts.last().time)
        assertEquals(98222.095, pts.last().openInterest, 1e-9)
    }

    @Test
    fun depthParses() {
        val b = Parse.depth(Fixtures.json("binance/futures_depth_BTCUSDT.json"), 0)
        assertEquals(100, b.bids.size)
        assertEquals(100, b.asks.size)
        assertEquals(73657.40, b.bids.first().price)
        assertTrue(b.time > 0)
    }
}
