package com.smartmoney.engine.exchange

import com.smartmoney.engine.Fixtures
import com.smartmoney.engine.model.Market
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The same coin must get the same canonical name on every exchange (recorded instrument lists). */
class SymbolNormalizationTest {

    @Test
    fun sameCanonicalAcrossExchanges() {
        val spot = listOf(
            BinanceAdapter.Parse.spotInstruments(Fixtures.json("binance/spot_exchangeInfo.json")),
            BybitAdapter.Parse.instruments(Fixtures.json("bybit/spot_instruments.json"), Market.SPOT),
            OkxAdapter.Parse.instruments(Fixtures.json("okx/spot_instruments.json"), Market.SPOT),
        )
        val perp = listOf(
            BinanceAdapter.Parse.futuresInstruments(Fixtures.json("binance/futures_exchangeInfo.json")),
            BybitAdapter.Parse.instruments(Fixtures.json("bybit/linear_instruments.json"), Market.PERP),
            OkxAdapter.Parse.instruments(Fixtures.json("okx/swap_instruments.json"), Market.PERP),
        )
        for (lists in listOf(spot, perp)) {
            for (coin in listOf("BTC/USDT", "ETH/USDT", "SOL/USDT")) {
                assertTrue(lists.all { l -> l.any { it.canonical == coin } }, "$coin on all three")
            }
        }
        val natives = perp.flatten().filter { it.canonical == "BTC/USDT" }.map { it.nativeSymbol }.toSet()
        assertEquals(setOf("BTCUSDT", "BTC-USDT-SWAP"), natives)
    }

    @Test
    fun multiplierPrefixes() {
        assertEquals("PEPE" to 1000.0, Symbols.perpBase("1000PEPE"))
        assertEquals("BABYDOGE" to 1_000_000.0, Symbols.perpBase("1MBABYDOGE"))
        assertEquals("LADYS" to 10_000.0, Symbols.perpBase("10000LADYS"))
        assertEquals("1INCH" to 1.0, Symbols.perpBase("1INCH"))
        assertEquals("BTC" to 1.0, Symbols.perpBase("BTC"))
    }

    @Test
    fun stablecoinsAndGoldAreNeverScreened() {
        assertTrue(Symbols.excluded("USDC"))
        assertTrue(Symbols.excluded("fdusd"))
        assertTrue(Symbols.excluded("PAXG"))
        assertFalse(Symbols.excluded("BTC"))
        assertTrue(Symbols.looksStable(1.0002, 0.0001))
        assertFalse(Symbols.looksStable(1.0002, 0.03), "a $1 coin that moved 3% is not a stablecoin")
        assertFalse(Symbols.looksStable(73000.0, 0.0001))
    }
}
