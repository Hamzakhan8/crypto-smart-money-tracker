package com.smartmoney.engine.stream

import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.net.WsConnection
import com.smartmoney.engine.net.WsListener
import com.smartmoney.engine.net.WsTransport
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import java.io.IOException
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A scripted WebSocket: the test decides when sockets open, talk and fail. */
class FakeTransport(private val now: () -> Long) : WsTransport {
    class Conn(val listener: WsListener, val openedAt: Long) : WsConnection {
        val sent = ArrayList<String>()
        var closed = false
        override fun send(text: String): Boolean {
            if (closed) return false
            sent += text
            return true
        }

        override fun close() {
            closed = true
        }
    }

    val conns = ArrayList<Conn>()

    /** When true, every new socket fails at once (exchange blocked or offline). */
    var refuse = false

    /** When true, every new socket opens at once. */
    var autoOpen = false

    override fun connect(url: String, listener: WsListener): WsConnection {
        val c = Conn(listener, now())
        conns += c
        if (refuse) listener.onFailure(IOException("refused")) else if (autoOpen) listener.onOpen()
        return c
    }
}

/** Test protocol: "c|SYMBOL|openTime|close|closed" lines are candles, "pong" is a pong, anything else is malformed. */
object TestProtocol : StreamProtocol {
    override val url = "wss://test"
    override val topicsPerRequest = 2
    override val maxTopicsPerConnection = 10
    override val minSendIntervalMs = 100L
    override val pingIntervalMs: Long? = 10_000L
    override fun pingMessage() = "ping"
    override val idleTimeoutMs = 30_000L
    override val maxConnectionAgeMs: Long? = null
    override fun subscribeMessages(nativeSymbols: List<String>, timeframe: Timeframe) = nativeSymbols.chunked(2).map { "sub:" + it.joinToString(",") }
    override fun parse(text: String): StreamEvent {
        if (text == "pong") return StreamEvent.Pong
        val p = text.split("|")
        require(p.size == 5 && p[0] == "c")
        val t = p[2].toLong()
        val c = p[3].toDouble()
        return StreamEvent.CandleUpdate(p[1], Timeframe.M1, listOf(Candle(t, c, c, c, c, 1.0, c, closed = p[4] == "1")), null)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectionManagerTest {

    private class Harness(scope: TestScope) {
        val now = { scope.testScheduler.currentTime }
        val transport = FakeTransport(now)
        val events = ArrayList<StreamEvent>()
        val connected = ArrayList<Long?>()
        val manager = ConnectionManager(
            protocol = TestProtocol, transport = transport, scope = scope.backgroundScope, now = now,
            onEvent = { events += it }, onConnected = { connected += it },
            random = Random(7), backoff = Backoff(1_000, 60_000, jitter = 0.0),
        )
    }

    @Test
    fun subscribesPacedThenGoesLive() = runTest {
        val h = Harness(this)
        h.manager.start(listOf("A", "B", "C"), Timeframe.M1)
        runCurrent()
        assertEquals(1, h.transport.conns.size)
        h.transport.conns[0].listener.onOpen()
        runCurrent()
        assertEquals(listOf("sub:A,B"), h.transport.conns[0].sent, "second request waits for the send interval")
        advanceTimeBy(101)
        assertEquals(listOf("sub:A,B", "sub:C"), h.transport.conns[0].sent)
        assertEquals(ConnPhase.LIVE, h.manager.state.value.phase)
        assertEquals(listOf<Long?>(null), h.connected, "first session: nothing to backfill")
    }

    @Test
    fun reconnectsWithGrowingDelaysWhileTheExchangeIsDown() = runTest {
        val h = Harness(this)
        h.transport.refuse = true
        h.manager.start(listOf("A"), Timeframe.M1)
        advanceTimeBy(1_000 + 2_000 + 4_000 + 8_000 + 100)
        val starts = h.transport.conns.map { it.openedAt }
        assertEquals(listOf(0L, 1_000L, 3_000L, 7_000L, 15_000L), starts)
        assertEquals(ConnPhase.WAITING_RETRY, h.manager.state.value.phase)
        assertEquals("refused", h.manager.state.value.lastError)
    }

    @Test
    fun reportsTheGapAfterAReconnect() = runTest {
        val h = Harness(this)
        h.transport.autoOpen = true
        h.manager.start(listOf("A"), Timeframe.M1)
        runCurrent()
        advanceTimeBy(2_000)
        h.transport.conns[0].listener.onMessage("c|A|0|1.0|1")
        runCurrent()
        val lastMessageAt = h.now()
        advanceTimeBy(5_000)
        h.transport.conns[0].listener.onFailure(IOException("network lost"))
        runCurrent()
        assertEquals(ConnPhase.WAITING_RETRY, h.manager.state.value.phase)
        advanceTimeBy(1_001)
        assertEquals(2, h.transport.conns.size)
        assertEquals(ConnPhase.LIVE, h.manager.state.value.phase)
        assertEquals(listOf(null, lastMessageAt), h.connected, "the caller backfills from the last message before the break")
        assertTrue(h.events.any { it is StreamEvent.CandleUpdate })
    }

    @Test
    fun silentConnectionIsReplaced() = runTest {
        val h = Harness(this)
        h.transport.autoOpen = true
        h.manager.start(listOf("A"), Timeframe.M1)
        runCurrent()
        advanceTimeBy(30_000 + 1)
        assertTrue(h.transport.conns[0].closed)
        assertTrue(h.manager.state.value.lastError!!.startsWith("no data"))
        advanceTimeBy(1_001)
        assertEquals(2, h.transport.conns.size)
    }

    @Test
    fun heartbeatPingsAndMeasuresLatency() = runTest {
        val h = Harness(this)
        h.transport.autoOpen = true
        h.manager.start(listOf("A"), Timeframe.M1)
        runCurrent()
        advanceTimeBy(10_000 + 1)
        val conn = h.transport.conns[0]
        assertTrue(conn.sent.contains("ping"))
        advanceTimeBy(249) // ping went out at exactly 10.000 s
        conn.listener.onMessage("pong")
        runCurrent()
        assertEquals(250L, h.manager.state.value.latencyMs)
        assertTrue(h.events.contains(StreamEvent.Pong))
    }

    @Test
    fun malformedMessagesAreCountedNotFatal() = runTest {
        val h = Harness(this)
        h.transport.autoOpen = true
        h.manager.start(listOf("A"), Timeframe.M1)
        runCurrent()
        val conn = h.transport.conns[0]
        conn.listener.onMessage("{garbage")
        conn.listener.onMessage("c|A|60000|2.0|0")
        runCurrent()
        assertEquals(1L, h.manager.state.value.malformed)
        assertEquals(1, h.transport.conns.size, "still the same connection")
        assertEquals(1, h.events.size)
    }

    @Test
    fun aMessageArrivingExactlyAtATimeoutIsNotLost() = runTest {
        // Regression: with withTimeout around receive, a message landing on the same instant as the ping deadline
        // was taken from the channel and then dropped by the timeout's cancellation.
        val h = Harness(this)
        h.transport.autoOpen = true
        h.manager.start(listOf("A"), Timeframe.M1)
        runCurrent()
        advanceTimeBy(10_000) // now exactly at the ping deadline; its timeout has not run yet
        h.transport.conns[0].listener.onMessage("c|A|0|1.0|1")
        h.transport.conns[0].listener.onFailure(IOException("dropped"))
        runCurrent()
        assertEquals(1, h.events.count { it is StreamEvent.CandleUpdate })
        advanceTimeBy(1_001)
        assertEquals(listOf<Long?>(null, 10_000L), h.connected, "the gap starts at that message")
    }

    @Test
    fun stopCancelsEverything() = runTest {
        val h = Harness(this)
        h.transport.autoOpen = true
        h.manager.start(listOf("A"), Timeframe.M1)
        runCurrent()
        h.manager.stop()
        advanceTimeBy(120_000)
        assertEquals(1, h.transport.conns.size)
        assertEquals(ConnPhase.STOPPED, h.manager.state.value.phase)
        assertNull(h.manager.state.value.nextRetryAt)
    }
}
