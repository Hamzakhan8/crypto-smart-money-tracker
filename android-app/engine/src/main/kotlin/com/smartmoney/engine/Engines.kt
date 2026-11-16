package com.smartmoney.engine

import com.smartmoney.engine.exchange.BinanceAdapter
import com.smartmoney.engine.exchange.BybitAdapter
import com.smartmoney.engine.exchange.ExchangeAdapter
import com.smartmoney.engine.exchange.OkxAdapter
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.net.HttpGet
import com.smartmoney.engine.net.OkHttpGet
import com.smartmoney.engine.net.OkHttpWsTransport
import com.smartmoney.engine.net.WsTransport
import com.smartmoney.engine.screener.EngineListener
import com.smartmoney.engine.screener.ScreenerEngine
import kotlinx.coroutines.CoroutineScope
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Builds a real engine: OkHttp for REST and WebSockets, one adapter per exchange. */
object Engines {
    fun httpClient(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** WebSockets: no read timeout (silence is detected by the connection manager), no OkHttp pings. */
    fun wsClient(base: OkHttpClient): OkHttpClient = base.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    fun adapters(http: HttpGet): Map<Exchange, ExchangeAdapter> = mapOf(
        Exchange.BINANCE to BinanceAdapter(http),
        Exchange.BYBIT to BybitAdapter(http),
        Exchange.OKX to OkxAdapter(http),
    )

    fun create(scope: CoroutineScope, listener: EngineListener, client: OkHttpClient = httpClient()): ScreenerEngine {
        val transport: WsTransport = OkHttpWsTransport(wsClient(client))
        return ScreenerEngine(adapters(OkHttpGet(client)), transport, scope, listener)
    }
}
