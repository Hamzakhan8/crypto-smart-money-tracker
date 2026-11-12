package com.smartmoney.engine.screener

import com.smartmoney.engine.exchange.ExchangeAdapter
import com.smartmoney.engine.exchange.Symbols
import com.smartmoney.engine.features.CandleSeries
import com.smartmoney.engine.features.DepthInfo
import com.smartmoney.engine.features.Liquidity
import com.smartmoney.engine.model.FeedId
import com.smartmoney.engine.model.Instrument
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.OpenInterestPoint
import com.smartmoney.engine.model.Ticker
import com.smartmoney.engine.net.ExchangeException
import com.smartmoney.engine.net.RateLimitedException
import com.smartmoney.engine.net.WsTransport
import com.smartmoney.engine.stream.Backoff
import com.smartmoney.engine.stream.ConnPhase
import com.smartmoney.engine.stream.ConnectionManager
import com.smartmoney.engine.stream.StreamEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlin.random.Random

enum class FeedPhase(val label: String) { DISABLED("off"), STARTING("starting"), LIVE("live"), DEGRADED("degraded"), OFFLINE("offline") }

data class FeedStatus(
    val id: FeedId,
    val phase: FeedPhase,
    val message: String? = null,
    val latencyMs: Long? = null,
    val lastDataAt: Long? = null,
    val universe: Int = 0,
    val malformed: Long = 0,
    val reconnects: Int = 0,
)

/** An exchange feed was down or the app was not scanning between [from] and [to]. Logged so statistics stay honest. */
data class GapRecord(val feed: FeedId, val from: Long, val to: Long, val reason: String)

/** Immutable copy of a feed's data for one scoring pass. */
data class FeedData(
    val id: FeedId,
    val universe: List<Instrument>,
    val series: Map<String, CandleSeries>,
    val tickers: Map<String, Ticker>,
    val openInterest: Map<String, List<OpenInterestPoint>>,
    val depth: Map<String, DepthInfo>,
)

/**
 * One exchange + market. Loads the instrument list and tickers, picks the most-traded USDT instruments, backfills
 * candles over REST, streams candle updates over WebSocket, refreshes tickers every 30 s and (perps) open interest
 * every 5 minutes, and backfills over REST after every reconnect. A failing exchange only affects its own feed.
 */
class Feed(
    val id: FeedId,
    private val adapter: ExchangeAdapter,
    private val transport: WsTransport,
    parent: CoroutineScope,
    private val now: () -> Long,
    private val config: EngineConfig,
    private val onGap: (GapRecord) -> Unit,
    private val random: Random = Random.Default,
) {
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]))
    private val mutex = Mutex()
    private var instruments: Map<String, Instrument> = emptyMap()
    private var universe: List<Instrument> = emptyList()
    private val series = HashMap<String, CandleSeries>()
    private var tickers: Map<String, Ticker> = emptyMap()
    private val oi = HashMap<String, List<OpenInterestPoint>>()
    private val depth = HashMap<String, DepthInfo>()
    private val managers = ArrayList<ConnectionManager>()
    private val restPermits = Semaphore(3)

    @Volatile private var restError: String? = null
    @Volatile private var restLatencyMs: Long? = null
    @Volatile private var bootError: String? = null
    @Volatile private var booted = false
    @Volatile private var lastDisconnectReason = "connection lost"

    private val _status = MutableStateFlow(FeedStatus(id, FeedPhase.STARTING, "connecting"))
    val status: StateFlow<FeedStatus> = _status.asStateFlow()

    fun start() {
        scope.launch { run() }
    }

    fun stop() {
        managers.forEach { it.stop() }
        scope.cancel()
    }

    suspend fun data(): FeedData = mutex.withLock {
        FeedData(id, universe, HashMap(series), tickers, HashMap(oi), HashMap(depth))
    }

    /** Fetches the order book now (detail screen and candidate checks). Null if it fails. */
    suspend fun refreshDepth(nativeSymbol: String): DepthInfo? {
        val inst = mutex.withLock { instruments[nativeSymbol] } ?: return null
        val book = try {
            rest { adapter.orderBook(inst) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return null
        }
        val info = Liquidity.analyze(book, config.tradeSizes) ?: return null
        mutex.withLock { depth[nativeSymbol] = info }
        return info
    }

    private suspend fun run() {
        val backoff = Backoff(2_000, 120_000)
        var attempt = 0
        scope.launch { statusLoop() }
        while (scope.isActive) {
            try {
                bootstrap()
                booted = true
                bootError = null
                break
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                attempt += 1
                bootError = describe(e)
                val wait = if (e is RateLimitedException) e.retryAfterMs else backoff.delayFor(attempt, random)
                delay(wait)
            }
        }
        startStreams()
        scope.launch { tickerLoop() }
        if (id.market == Market.PERP) scope.launch { openInterestLoop() }
    }

    private suspend fun bootstrap() {
        val all = rest { adapter.instruments(id.market) }.filter { it.quote == "USDT" }
        val tks = rest { adapter.tickers(id.market) }
        val byNative = all.associateBy { it.nativeSymbol }
        val tickerMap = tks.associateBy { it.nativeSymbol }
        val ranked = all.filter { inst ->
            val t = tickerMap[inst.nativeSymbol]
            inst.trading && !Symbols.excluded(inst.base) && !Symbols.looksStable(t?.last?.div(inst.priceMultiplier), t?.change24hPct)
        }.sortedByDescending { tickerMap[it.nativeSymbol]?.quoteVolume24h ?: 0.0 }
        val chosen = ranked.take(config.universeSize).toMutableList()
        ranked.firstOrNull { it.base == "BTC" }?.let { btc -> if (chosen.none { it.base == "BTC" }) chosen += btc }
        if (chosen.isEmpty()) throw ExchangeException("${id.exchange.label}: no trading USDT markets found")
        mutex.withLock {
            instruments = byNative
            universe = chosen
            tickers = tickerMap
        }
        restError = null
        backfill(chosen, sinceOpenTime = null)
    }

    /** REST candles for [insts]. [sinceOpenTime] null = initial load; otherwise fill from that time to now. */
    private suspend fun backfill(insts: List<Instrument>, sinceOpenTime: Long?) {
        val tf = config.timeframe
        val limit = if (sinceOpenTime == null) INITIAL_CANDLES
        else (((now() - sinceOpenTime) / tf.millis) + 3).toInt().coerceIn(3, adapter.maxCandlesPerRequest)
        val failures = java.util.concurrent.atomic.AtomicInteger(0)
        val lastError = java.util.concurrent.atomic.AtomicReference<Exception?>(null)
        coroutineScopeAll(insts) { inst ->
            try {
                val cs = rest { adapter.candles(inst, tf, minOf(limit, adapter.maxCandlesPerRequest)) }
                mutex.withLock { series[inst.nativeSymbol] = (series[inst.nativeSymbol] ?: CandleSeries(MAX_CANDLES)).merge(cs) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failures.incrementAndGet()
                lastError.set(e)
                if (e is RateLimitedException) delay(e.retryAfterMs)
            }
        }
        if (failures.get() > 0) restError = "candles: ${failures.get()} of ${insts.size} failed (${lastError.get()?.let { describe(it) }})"
        if (sinceOpenTime == null && failures.get() == insts.size && insts.isNotEmpty()) throw lastError.get() ?: ExchangeException("candle backfill failed")
    }

    private suspend fun coroutineScopeAll(insts: List<Instrument>, block: suspend (Instrument) -> Unit) {
        kotlinx.coroutines.coroutineScope {
            insts.map { inst -> async { restPermits.withPermit { block(inst) } } }.awaitAll()
        }
    }

    private fun startStreams() {
        val protocol = adapter.streamProtocol(id.market)
        val chunks = universe.map { it.nativeSymbol }.chunked(protocol.maxTopicsPerConnection)
        for (chunk in chunks) {
            val chunkInsts = universe.filter { it.nativeSymbol in chunk }
            val manager = ConnectionManager(
                protocol = protocol,
                transport = transport,
                scope = scope,
                now = now,
                onEvent = { handle(it) },
                onConnected = { previous -> onConnected(chunkInsts, previous) },
                onDisconnected = { reason -> lastDisconnectReason = reason },
                random = random,
            )
            managers += manager
            manager.start(chunk, config.timeframe)
        }
    }

    private fun onConnected(insts: List<Instrument>, previousLastMessageAt: Long?) {
        val t = now()
        if (previousLastMessageAt != null) {
            onGap(GapRecord(id, previousLastMessageAt, t, lastDisconnectReason))
        }
        // Candles that closed while we were not listening (or between the initial load and subscribing).
        val since = previousLastMessageAt ?: (t - 3 * config.timeframe.millis)
        scope.launch {
            try {
                backfill(insts, config.timeframe.floor(since))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                restError = describe(e)
            }
        }
    }

    private suspend fun handle(event: StreamEvent) {
        if (event !is StreamEvent.CandleUpdate || event.timeframe != config.timeframe) return
        mutex.withLock {
            if (event.nativeSymbol !in instruments) return
            series[event.nativeSymbol] = (series[event.nativeSymbol] ?: CandleSeries(MAX_CANDLES)).merge(event.candles)
        }
    }

    private suspend fun tickerLoop() {
        while (scope.isActive) {
            delay(TICKER_INTERVAL_MS)
            try {
                val tks = rest { adapter.tickers(id.market) }
                mutex.withLock { tickers = tks.associateBy { it.nativeSymbol } }
                restError = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                restError = describe(e)
                if (e is RateLimitedException) delay(e.retryAfterMs)
            }
        }
    }

    private suspend fun openInterestLoop() {
        var first = true
        while (scope.isActive) {
            val insts = mutex.withLock { universe.toList() }
            coroutineScopeAll(insts) { inst ->
                try {
                    val pts = rest { adapter.openInterestHistory(inst, if (first) 30 else 4) }
                    mutex.withLock {
                        val merged = ((oi[inst.nativeSymbol] ?: emptyList()) + pts).associateBy { it.time }.values.sortedBy { it.time }
                        oi[inst.nativeSymbol] = merged.takeLast(60)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (e is RateLimitedException) delay(e.retryAfterMs)
                }
            }
            first = false
            delay(OI_INTERVAL_MS)
        }
    }

    private suspend fun statusLoop() {
        while (scope.isActive) {
            _status.value = computeStatus()
            delay(1_000)
        }
    }

    private fun computeStatus(): FeedStatus {
        val states = managers.map { it.state.value }
        val live = states.count { it.phase == ConnPhase.LIVE }
        val lastData = states.mapNotNull { it.lastMessageAt }.maxOrNull()
        val latency = states.mapNotNull { it.latencyMs }.maxOrNull() ?: restLatencyMs
        val malformed = states.sumOf { it.malformed }
        val reconnects = states.sumOf { it.reconnects }
        val n = universe.size
        if (!booted) {
            return FeedStatus(id, if (bootError == null) FeedPhase.STARTING else FeedPhase.OFFLINE, bootError ?: "loading markets", latency, lastData, n, malformed, reconnects)
        }
        val wsError = states.firstOrNull { it.phase != ConnPhase.LIVE }?.lastError
        val (phase, msg) = when {
            states.isEmpty() -> FeedPhase.STARTING to "starting streams"
            live == states.size && restError == null -> FeedPhase.LIVE to null
            live == 0 -> FeedPhase.OFFLINE to (wsError ?: restError ?: "reconnecting")
            else -> FeedPhase.DEGRADED to (restError ?: wsError ?: "some streams reconnecting")
        }
        return FeedStatus(id, phase, msg, latency, lastData, n, malformed, reconnects)
    }

    private suspend fun <T> rest(block: suspend () -> T): T {
        val t0 = now()
        val result = withTimeoutOrNull(REST_TIMEOUT_MS) { block() } ?: throw IOException("request timed out")
        restLatencyMs = now() - t0
        return result
    }

    companion object {
        const val INITIAL_CANDLES = 150
        const val MAX_CANDLES = 300
        const val TICKER_INTERVAL_MS = 30_000L
        const val OI_INTERVAL_MS = 5 * 60_000L
        const val REST_TIMEOUT_MS = 20_000L

        fun describe(e: Exception): String = when (e) {
            is RateLimitedException -> "rate limited, pausing ${e.retryAfterMs / 1000} s"
            is ExchangeException -> when (e.httpCode) {
                451, 403 -> "blocked here (HTTP ${e.httpCode}): ${e.message}"
                else -> e.message ?: "exchange error"
            }
            is UnknownHostException -> "no internet or exchange blocked (DNS)"
            is SocketTimeoutException -> "timed out"
            is IOException -> e.message ?: "network error"
            else -> e.message ?: e.javaClass.simpleName
        }
    }
}
