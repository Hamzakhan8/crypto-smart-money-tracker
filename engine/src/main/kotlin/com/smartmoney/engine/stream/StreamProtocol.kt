package com.smartmoney.engine.stream

import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Timeframe

/** What one incoming WebSocket text message meant. */
sealed interface StreamEvent {
    /**
     * Candle updates for one symbol; [Candle.closed] tells whether the exchange marked each one final. One message can
     * hold several candles (Bybit linear sends the closed candle and the new one together).
     */
    data class CandleUpdate(
        val nativeSymbol: String,
        val timeframe: Timeframe,
        val candles: List<Candle>,
        /** Exchange's event timestamp, when the message carries one. */
        val eventTime: Long?,
    ) : StreamEvent

    data object Pong : StreamEvent
    data class Ack(val detail: String) : StreamEvent
    data class Error(val detail: String) : StreamEvent
    data object Ignored : StreamEvent
}

/** One exchange's WebSocket rules for one market, taken from its official docs (see docs/DATA_INVENTORY.md). */
interface StreamProtocol {
    val url: String

    /** Topics in one subscribe request. */
    val topicsPerRequest: Int

    /** Topics on one connection; the feed opens more connections above this. */
    val maxTopicsPerConnection: Int

    /** Minimum gap between messages we send (the exchange's incoming-message limit). */
    val minSendIntervalMs: Long

    /** Interval for client text pings, or null when the server pings and OkHttp answers (Binance). */
    val pingIntervalMs: Long?

    fun pingMessage(): String?

    /** Reconnect when nothing arrives for this long. */
    val idleTimeoutMs: Long

    /** Reconnect on our own before the exchange's connection lifetime ends, or null if there is none. */
    val maxConnectionAgeMs: Long?

    fun subscribeMessages(nativeSymbols: List<String>, timeframe: Timeframe): List<String>

    /** Parses one message. Throws on malformed input; the connection manager counts and skips it. */
    fun parse(text: String): StreamEvent
}
