package com.smartmoney.engine.exchange

import com.smartmoney.engine.Fixtures
import com.smartmoney.engine.exchange.OkxAdapter.Parse
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.stream.StreamEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** OKX v5 SPOT and SWAP, on responses recorded 2026-11-12. */
class OkxRecordedTest {

    @Test
    fun spotInstrumentsAreCryptoOnly() {
        val list = Parse.instruments(Fixtures.json("okx/spot_instruments.json"), Market.SPOT)
        assertEquals(listOf("BTC-USDT", "ETH-USDT", "SOL-USDT"), list.map { it.nativeSymbol }, "XCVNA-USDT (stock) left out")
        assertEquals("BTC/USDT", list.first().canonical)
    }

    @Test
    fun swapInstrumentsAreLinearUsdtCrypto() {
        val list = Parse.instruments(Fixtures.json("okx/swap_instruments.json"), Market.PERP)
        // Left out: BTC-USD-SWAP (inverse), ANTHROPIC-USDT-SWAP and AAOI-USDT-SWAP (instCategory 3).
        assertEquals(listOf("BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"), list.map { it.nativeSymbol })
        val btc = list.first()
        assertEquals("BTC/USDT", btc.canonical)
        assertEquals(0.01, btc.contractValue)
        assertTrue(btc.trading)
    }

    @Test
    fun candlesUseTheConfirmFlag() {
        val c = Parse.candles(Fixtures.json("okx/swap_candles_BTC-USDT-SWAP_5m.json"), Market.PERP)
        assertEquals(100, c.size)
        assertEquals(1794434400000L, c.first().openTime)
        assertEquals(1794464100000L, c.last().openTime)
        assertFalse(c.last().closed, "confirm 0")
        val prev = c[c.size - 2]
        assertTrue(prev.closed, "confirm 1")
        assertEquals(73636.3, prev.close)
        assertEquals(83.3019, prev.baseVolume, 1e-9, "swap volume in coins (volCcy), not contracts")
        assertEquals(6133420.34309, prev.quoteVolume!!, 1e-6)
    }

    @Test
    fun swapTickerQuoteVolumeIsCoinsTimesLast() {
        val t = Parse.tickers(Fixtures.json("okx/swap_tickers.json"), Market.PERP).first { it.nativeSymbol == "BTC-USDT-SWAP" }
        assertEquals(70434.6307 * 73647.3, t.quoteVolume24h!!, 1e-3)
        assertEquals(73647.3 / 73822.4 - 1, t.change24hPct!!, 1e-12)
        assertEquals(73647.3, t.bid)
        assertNull(t.markPrice, "filled from the mark-price endpoint, not the ticker")
    }

    @Test
    fun fundingAnyKeepsSwapsOnly() {
        val f = Parse.funding(Fixtures.json("okx/swap_funding_rate_ANY.json"))
        assertEquals(0.0001, f.getValue("BTC-USDT-SWAP").first)
        assertEquals(1794470400000L, f.getValue("BTC-USDT-SWAP").second)
    }

    @Test
    fun swapBookSizesConvertedToCoins() {
        val b = Parse.orderBook(Fixtures.json("okx/swap_books_BTC-USDT-SWAP.json"), 0.01)
        assertEquals(400, b.asks.size)
        assertEquals(73656.8, b.asks.first().price)
        assertEquals(3.5614, b.asks.first().size, 1e-9)
        assertEquals(12.4551, b.bids.first().size, 1e-9)
    }

    @Test
    fun spotStreamReplay() {
        val r = Fixtures.replay("okx/ws_candle1m_spot.jsonl", OkxAdapter.Stream::parse)
        assertEquals(0, r.malformed)
        assertEquals(59, r.events.size)
        assertEquals(3, r.pongs)
        val btc = r.series().getValue("BTC-USDT").candles.first { it.openTime == 1794464280000L }
        assertTrue(btc.closed)
        assertEquals(73678.6, btc.close)
        assertEquals(23240.166548382, btc.quoteVolume!!, 1e-6)
    }

    @Test
    fun swapStreamReplay() {
        val r = Fixtures.replay("okx/ws_candle1m_swap.jsonl", OkxAdapter.Stream::parse)
        assertEquals(0, r.malformed)
        assertEquals(181, r.events.size)
        val btc = r.series().getValue("BTC-USDT-SWAP").candles.first { it.openTime == 1794464280000L }
        assertTrue(btc.closed)
        assertEquals(73647.3, btc.close)
        assertEquals(758332.92419, btc.quoteVolume!!, 1e-6)
    }

    @Test
    fun errorsAndNoticesAreRecognised() {
        val err = Fixtures.replay("okx/ws_subscribe_error.jsonl", OkxAdapter.Stream::parse)
        assertEquals(0, err.malformed)
        assertTrue(err.errors.isNotEmpty() && err.errors.all { it.detail.startsWith("60018") })
        val notice = OkxAdapter.Stream.parse(Fixtures.lines("okx/ws_port8443_notice.jsonl").first())
        assertEquals(StreamEvent.Ignored, notice)
        assertEquals("wss://ws.okx.com/ws/v5/business", OkxAdapter.Stream.url)
    }

    @Test
    fun openInterestHistoryInCoins() {
        val pts = Parse.openInterestHistory(Fixtures.json("okx/rubik_open_interest_history_BTC-USDT-SWAP_5m.json"))
        assertEquals(100, pts.size)
        assertTrue(pts.zipWithNext().all { (a, b) -> a.time < b.time })
        assertEquals(35334.197700000157, pts.last().openInterest, 1e-9)
    }
}
