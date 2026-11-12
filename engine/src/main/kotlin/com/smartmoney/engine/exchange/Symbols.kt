package com.smartmoney.engine.exchange

import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.net.HttpGet
import com.smartmoney.engine.net.HttpResponse
import com.smartmoney.engine.net.RateLimitedException
import com.smartmoney.engine.net.RateLimiter
import com.smartmoney.engine.net.retryAfterMs

/** Symbol normalization shared by the adapters. */
object Symbols {
    private val multiplierPrefix = Regex("^(1000000|100000|10000|1000|1M)(?=[A-Z])")

    /**
     * Perp contracts quoted per 1,000 (or 10,000, 1M) coins carry the multiplier in the name: 1000PEPE, 1MBABYDOGE.
     * Returns the plain coin and the multiplier. Spot names are left alone (1000SATS is a real spot token name).
     */
    fun perpBase(rawBase: String): Pair<String, Double> {
        val m = multiplierPrefix.find(rawBase) ?: return rawBase to 1.0
        val mult = if (m.value == "1M") 1_000_000.0 else m.value.toDouble()
        return rawBase.substring(m.value.length) to mult
    }

    /**
     * Never screened: stablecoins, fiat, gold and wrapped coins (they do not "run"), and index contracts. Taken from
     * the lists this repo already uses (perps-history.ts EXCLUDED, liquidity.ts SKIP).
     */
    val EXCLUDED_BASES: Set<String> = setOf(
        "USDT", "USDC", "FDUSD", "TUSD", "BUSD", "USDP", "DAI", "USDE", "USD1", "PYUSD", "RLUSD", "USDS", "USDG", "USDQ", "USDR",
        "USD0", "USDX", "USDB", "BFUSD", "USDD", "LUSD", "GUSD", "PAX", "SUSD", "FRAX", "DOLA", "VAI", "XUSD", "U",
        "EUR", "AEUR", "EURC", "EURI", "EURQ", "EURT", "EURR", "GBP", "TRY", "BRL", "AUD", "CAD", "CHF", "JPY", "MXN", "ZAR",
        "PLN", "UAH", "ARS", "IDR",
        "XAU", "XAG", "XPT", "XPD", "XAUT", "PAXG",
        "WBTC", "WBETH", "STETH", "BTCDOM", "DEFI",
    )

    /** A coin pinned near $1 that barely moved in 24 hours is a stablecoin whatever its name (from liquidity.ts). */
    fun looksStable(last: Double?, change24h: Double?): Boolean =
        last != null && last > 0.99 && last < 1.01 && change24h != null && kotlin.math.abs(change24h) < 0.005

    fun excluded(base: String): Boolean = base.uppercase() in EXCLUDED_BASES
}

/** One GET with the exchange's rate limiter; HTTP 429 / 418 pause every request to that exchange. */
internal suspend fun fetch(http: HttpGet, limiter: RateLimiter, url: String, exchange: Exchange): HttpResponse {
    limiter.acquire()
    val r = http.get(url)
    if (r.code == 429 || r.code == 418) {
        val ms = retryAfterMs(r, if (r.code == 418) 5 * 60_000L else 60_000L)
        limiter.pause(ms)
        throw RateLimitedException("${exchange.label}: HTTP ${r.code} rate limit, pausing ${ms / 1000} s", ms, r.code)
    }
    return r
}
