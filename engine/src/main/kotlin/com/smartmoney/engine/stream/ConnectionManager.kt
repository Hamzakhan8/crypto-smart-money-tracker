package com.smartmoney.engine.stream

import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.net.WsConnection
import com.smartmoney.engine.net.WsListener
import com.smartmoney.engine.net.WsTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import kotlin.math.min
import kotlin.random.Random

enum class ConnPhase { IDLE, CONNECTING, LIVE, WAITING_RETRY, STOPPED }

data class ConnState(
    val phase: ConnPhase = ConnPhase.IDLE,
    /** Failed attempts since the last live session. */
    val attempt: Int = 0,
    val nextRetryAt: Long? = null,
    val lastMessageAt: Long? = null,
    val lastError: String? = null,
    /** Messages that could not be parsed (skipped, never fatal). */
    val malformed: Long = 0,
    /** Ping round trip (Bybit, OKX) or event-time lag (Binance), in ms. */
    val latencyMs: Long? = null,
    val reconnects: Int = 0,
)

/** Exponential backoff with jitter: 1 s, 2 s, 4 s ... up to [maxMs]. */
class Backoff(private val baseMs: Long = 1_000, private val maxMs: Long = 60_000, private val jitter: Double = 0.2) {
    fun delayFor(attempt: Int, random: Random): Long {
        val exp = baseMs * (1L shl (attempt - 1).coerceIn(0, 16))
        val capped = min(exp, maxMs).toDouble()
        val j = 1.0 + (random.nextDouble() * 2 - 1) * jitter
        return (capped * j).toLong().coerceAtLeast(baseMs / 2)
    }
}

/**
 * Keeps one WebSocket connection alive for a list of symbols: connects, subscribes (paced to the exchange's
 * message limit), sends heartbeats, reconnects with growing delays after any failure or silence, and reports each
 * reconnect to [onConnected] with the time of the last message before the break, so the caller can backfill the gap
 * over REST. All state changes happen on one coroutine; transport callbacks only post to a channel.
 */
class ConnectionManager(
    private val protocol: StreamProtocol,
    private val transport: WsTransport,
    private val scope: CoroutineScope,
    private val now: () -> Long,
    private val onEvent: suspend (StreamEvent) -> Unit,
    /** Called once per live session, after subscribing. [previousLastMessageAt] is null for the first session. */
    private val onConnected: suspend (previousLastMessageAt: Long?) -> Unit,
    private val onDisconnected: suspend (reason: String) -> Unit = {},
    private val random: Random = Random.Default,
    private val backoff: Backoff = Backoff(),
    private val connectTimeoutMs: Long = 15_000,
) {
    private val _state = MutableStateFlow(ConnState())
    val state: StateFlow<ConnState> = _state.asStateFlow()

    private var job: Job? = null

    private sealed interface Signal {
        val gen: Int

        data class Opened(override val gen: Int) : Signal
        data class Message(override val gen: Int, val text: String) : Signal
        data class Closed(override val gen: Int, val reason: String) : Signal
    }

    fun start(nativeSymbols: List<String>, timeframe: Timeframe) {
        stop()
        _state.value = ConnState()
        job = scope.launch { runLoop(nativeSymbols, timeframe) }
    }

    fun stop() {
        job?.cancel()
        job = null
        _state.update { it.copy(phase = ConnPhase.STOPPED, nextRetryAt = null) }
    }

    private suspend fun runLoop(symbols: List<String>, timeframe: Timeframe) {
        var gen = 0
        var lastSessionMessageAt: Long? = null
        var attempt = 0
        while (scope.isActive) {
            gen += 1
            val channel = Channel<Signal>(Channel.UNLIMITED)
            val myGen = gen
            _state.update { it.copy(phase = ConnPhase.CONNECTING, nextRetryAt = null) }
            val conn: WsConnection? = try {
                transport.connect(protocol.url, object : WsListener {
                    override fun onOpen() { channel.trySend(Signal.Opened(myGen)) }
                    override fun onMessage(text: String) { channel.trySend(Signal.Message(myGen, text)) }
                    override fun onClosed(code: Int, reason: String) {
                        channel.trySend(Signal.Closed(myGen, "closed by server ($code${if (reason.isNotBlank()) ": $reason" else ""})"))
                    }
                    override fun onFailure(error: Throwable) {
                        channel.trySend(Signal.Closed(myGen, error.message ?: error.javaClass.simpleName))
                    }
                })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                channel.trySend(Signal.Closed(myGen, e.message ?: e.javaClass.simpleName))
                null
            }
            val result = try {
                if (conn == null) SessionResult(false, null, lastReason(channel)) else session(conn, channel, myGen, symbols, timeframe, lastSessionMessageAt)
            } finally {
                conn?.close()
                channel.close()
            }
            if (result.lastMessageAt != null) lastSessionMessageAt = result.lastMessageAt
            if (result.wasLive) {
                attempt = 0
                _state.update { it.copy(reconnects = it.reconnects + 1) }
            }
            attempt += 1
            // Only a live session ending is a disconnect (failed retries after it do not replace its reason).
            if (result.wasLive) onDisconnected(result.reason)
            val wait = backoff.delayFor(attempt, random)
            _state.update { it.copy(phase = ConnPhase.WAITING_RETRY, attempt = attempt, nextRetryAt = now() + wait, lastError = result.reason) }
            delay(wait)
        }
    }

    /**
     * Next signal, or null after [timeoutMs]. Uses select, not withTimeout around receive: a timeout racing a delivery
     * must never drop the message (a lost closed-candle message would never come back).
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun receiveOrNull(channel: Channel<Signal>, timeoutMs: Long): Signal? = select {
        channel.onReceive { it }
        onTimeout(timeoutMs.coerceAtLeast(1)) { null }
    }

    private fun lastReason(channel: Channel<Signal>): String =
        (channel.tryReceive().getOrNull() as? Signal.Closed)?.reason ?: "could not connect"

    private class SessionResult(val wasLive: Boolean, val lastMessageAt: Long?, val reason: String)

    private suspend fun session(
        conn: WsConnection,
        channel: Channel<Signal>,
        gen: Int,
        symbols: List<String>,
        timeframe: Timeframe,
        previousLastMessageAt: Long?,
    ): SessionResult {
        // 1. Wait for the socket to open.
        val openBy = now() + connectTimeoutMs
        var first: Signal
        do {
            first = receiveOrNull(channel, openBy - now()) ?: return SessionResult(false, null, "connect timeout")
        } while (first.gen != gen)
        if (first is Signal.Closed) return SessionResult(false, null, first.reason)

        // 2. Subscribe, paced.
        val messages = protocol.subscribeMessages(symbols, timeframe)
        for ((i, m) in messages.withIndex()) {
            if (i > 0) delay(protocol.minSendIntervalMs)
            if (!conn.send(m)) return SessionResult(false, null, "send failed while subscribing")
        }
        val connectedAt = now()
        var lastMessageAt = connectedAt
        var gotMessage = false
        var nextPingAt = protocol.pingIntervalMs?.let { connectedAt + it }
        var pingSentAt: Long? = null
        _state.update { it.copy(phase = ConnPhase.LIVE, attempt = 0, nextRetryAt = null, lastError = null) }
        onConnected(previousLastMessageAt)

        // 3. Read until something breaks.
        while (true) {
            val t = now()
            var deadline = lastMessageAt + protocol.idleTimeoutMs
            nextPingAt?.let { deadline = min(deadline, it) }
            protocol.maxConnectionAgeMs?.let { deadline = min(deadline, connectedAt + it) }
            val signal = receiveOrNull(channel, deadline - t)
            val t2 = now()
            if (signal == null) {
                if (t2 - lastMessageAt >= protocol.idleTimeoutMs) {
                    return SessionResult(true, if (gotMessage) lastMessageAt else null, "no data for ${protocol.idleTimeoutMs / 1000} s")
                }
                protocol.maxConnectionAgeMs?.let { age ->
                    if (t2 - connectedAt >= age) return SessionResult(true, if (gotMessage) lastMessageAt else null, "planned reconnect (connection age limit)")
                }
                val p = nextPingAt
                if (p != null && t2 >= p) {
                    protocol.pingMessage()?.let { conn.send(it) }
                    pingSentAt = t2
                    nextPingAt = t2 + (protocol.pingIntervalMs ?: 0)
                }
                continue
            }
            if (signal.gen != gen) continue
            when (signal) {
                is Signal.Opened -> Unit
                is Signal.Closed -> return SessionResult(true, if (gotMessage) lastMessageAt else null, signal.reason)
                is Signal.Message -> {
                    lastMessageAt = t2
                    gotMessage = true
                    val event = try {
                        protocol.parse(signal.text)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        _state.update { it.copy(malformed = it.malformed + 1, lastMessageAt = t2) }
                        continue
                    }
                    var latency: Long? = null
                    if (event is StreamEvent.Pong && pingSentAt != null) {
                        latency = t2 - pingSentAt!!
                        pingSentAt = null
                    } else if (event is StreamEvent.CandleUpdate && protocol.pingIntervalMs == null) {
                        event.eventTime?.let { latency = (t2 - it).coerceAtLeast(0) }
                    }
                    _state.update { it.copy(lastMessageAt = t2, latencyMs = latency ?: it.latencyMs) }
                    onEvent(event)
                }
            }
        }
    }
}
