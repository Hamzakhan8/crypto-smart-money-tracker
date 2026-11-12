package com.smartmoney.engine.screener

import com.smartmoney.engine.exchange.ExchangeAdapter
import com.smartmoney.engine.features.DepthInfo
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.FeedId
import com.smartmoney.engine.model.InstrumentKey
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.net.WsTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlin.math.abs

data class EngineSnapshot(
    val rows: List<ScreenerRow> = emptyList(),
    val feeds: List<FeedStatus> = emptyList(),
    val config: EngineConfig = EngineConfig(),
    val time: Long = 0,
    val running: Boolean = false,
)

/** One closed candle with an unusual move, logged whether it passed the gates or not. */
data class HitRecord(
    val candleOpenTime: Long,
    val loggedAt: Long,
    val exchange: Exchange,
    val market: Market,
    val canonical: String,
    val nativeSymbol: String,
    val timeframe: Timeframe,
    val tier: Tier,
    val label: SignalLabel?,
    val direction: Direction?,
    val price: Double,
    val move: Double?,
    val zMove: Double?,
    val relVolume: Double?,
    val residual: Double?,
    val oiChange: Double?,
    val fundingRate: Double?,
    val invalidation: Double?,
    val failedGates: List<String>,
    val flags: List<String>,
    val confirmations: Int,
    val reason: String,
    val engineVersion: String,
    val configHash: String,
)

interface EngineListener {
    fun onHit(hit: HitRecord)
    fun onGap(gap: GapRecord)
}

/**
 * Runs one [Feed] per enabled exchange and market, rebuilds every screener row once per second (the UI never gets
 * more than one update per second), and logs every closed candle with an unusual move through [listener].
 */
class ScreenerEngine(
    private val adapters: Map<Exchange, ExchangeAdapter>,
    private val transport: WsTransport,
    private val scope: CoroutineScope,
    private val listener: EngineListener,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _snapshot = MutableStateFlow(EngineSnapshot())
    val snapshot: StateFlow<EngineSnapshot> = _snapshot.asStateFlow()

    @Volatile private var feeds: Map<FeedId, Feed> = emptyMap()
    @Volatile private var config = EngineConfig()
    private var loopJob: Job? = null
    private val lastProcessed = HashMap<InstrumentKey, Long>()
    private val depthRequested = HashMap<InstrumentKey, Long>()
    private val depthPermits = Semaphore(2)

    val isRunning: Boolean get() = loopJob?.isActive == true

    @Synchronized
    fun start(cfg: EngineConfig) {
        if (isRunning) {
            updateConfig(cfg)
            return
        }
        config = cfg
        startFeeds()
        loopJob = scope.launch { tickLoop() }
    }

    @Synchronized
    fun stop() {
        loopJob?.cancel()
        loopJob = null
        stopFeeds()
        _snapshot.value = _snapshot.value.copy(running = false, feeds = emptyList())
    }

    @Synchronized
    fun updateConfig(cfg: EngineConfig) {
        val restart = cfg.needsRestart(config)
        config = cfg
        if (isRunning && restart) {
            stopFeeds()
            startFeeds()
        }
    }

    /** Candles of one instrument at the current timeframe, oldest first (for the chart). */
    suspend fun candles(key: InstrumentKey): List<Candle> {
        val feed = feeds[FeedId(key.exchange, key.market)] ?: return emptyList()
        val data = feed.data()
        val native = data.universe.firstOrNull { it.key == key }?.nativeSymbol ?: return emptyList()
        return data.series[native]?.candles ?: emptyList()
    }

    /** Fetches the order book now (detail screen). */
    suspend fun refreshDepth(key: InstrumentKey): DepthInfo? {
        val feed = feeds[FeedId(key.exchange, key.market)] ?: return null
        val native = feed.data().universe.firstOrNull { it.key == key }?.nativeSymbol ?: return null
        return feed.refreshDepth(native)
    }

    private fun startFeeds() {
        lastProcessed.clear()
        depthRequested.clear()
        val cfg = config
        val map = LinkedHashMap<FeedId, Feed>()
        for (exchange in Exchange.entries) {
            if (exchange !in cfg.exchanges) continue
            val adapter = adapters[exchange] ?: continue
            for (market in Market.entries) {
                if (market !in cfg.markets) continue
                val id = FeedId(exchange, market)
                map[id] = Feed(id, adapter, transport, scope, now, cfg, onGap = { listener.onGap(it) })
            }
        }
        feeds = map
        map.values.forEach { it.start() }
    }

    private fun stopFeeds() {
        feeds.values.forEach { it.stop() }
        feeds = emptyMap()
    }

    private suspend fun tickLoop() {
        while (scope.isActive) {
            try {
                tick()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // A scoring bug must not kill the scanner; the next tick tries again.
            }
            delay(1_000)
        }
    }

    private suspend fun tick() {
        val current = feeds
        val cfg = config
        val t = now()
        val datas = current.values.map { it.data() }
        val rows = RowBuilder.applyCross(datas.flatMap { buildRows(it, cfg, t) })
        processCloses(rows, current, cfg, t)
        _snapshot.value = EngineSnapshot(rows, current.values.map { it.status.value }, cfg, t, true)
    }

    private fun buildRows(data: FeedData, cfg: EngineConfig, t: Long): List<ScreenerRow> {
        val btcInst = data.universe.firstOrNull { it.base == "BTC" }
        val btcMap = btcInst?.let { b -> data.series[b.nativeSymbol]?.candles?.associateBy { it.openTime } }
        return data.universe.map { inst ->
            RowBuilder.build(
                inst = inst,
                series = data.series[inst.nativeSymbol],
                btc = if (inst.base == "BTC") null else btcMap,
                ticker = data.tickers[inst.nativeSymbol],
                oi = data.openInterest[inst.nativeSymbol],
                depth = data.depth[inst.nativeSymbol],
                config = cfg,
                now = t,
            )
        }
    }

    private fun processCloses(rows: List<ScreenerRow>, current: Map<FeedId, Feed>, cfg: EngineConfig, t: Long) {
        val btcClosed = rows.filter { it.instrument.base == "BTC" }
            .associate { it.instrument.feed to (it.closed?.candleOpenTime ?: Long.MIN_VALUE) }
        for (row in rows) {
            val f = row.closed ?: continue
            val key = row.instrument.key
            val ot = f.candleOpenTime
            val prev = lastProcessed[key]
            if (prev == null) {
                // First sight after a start: that candle came from the backfill, so it is not logged as live.
                lastProcessed[key] = ot
                continue
            }
            if (ot <= prev) continue
            val isCandidate = f.zMove?.let { abs(it) >= cfg.moveThresholdZ } == true
            if (!isCandidate) {
                lastProcessed[key] = ot
                continue
            }
            val closeTime = ot + cfg.timeframe.millis
            // Residual move needs BTC's candle of the same period; wait for it a little.
            if ((btcClosed[row.instrument.feed] ?: Long.MIN_VALUE) < ot && t < closeTime + 10_000) continue
            if (row.depth == null) {
                val asked = depthRequested[key]
                if (asked == null || asked < closeTime) {
                    depthRequested[key] = t
                    val feed = current[row.instrument.feed]
                    if (feed != null) scope.launch { depthPermits.withPermit { feed.refreshDepth(row.instrument.nativeSymbol) } }
                    continue
                }
                if (t < closeTime + 30_000) continue
            }
            lastProcessed[key] = ot
            listener.onHit(row.toHit(t, cfg))
        }
    }

    private fun ScreenerRow.toHit(t: Long, cfg: EngineConfig): HitRecord {
        val f = closed!!
        return HitRecord(
            candleOpenTime = f.candleOpenTime, loggedAt = t, exchange = instrument.exchange, market = instrument.market,
            canonical = instrument.canonical, nativeSymbol = instrument.nativeSymbol, timeframe = timeframe, tier = tier,
            label = label, direction = direction, price = f.price, move = f.move, zMove = f.zMove, relVolume = f.relVolume,
            residual = f.residual, oiChange = perp?.oiChange, fundingRate = perp?.fundingRate, invalidation = invalidation,
            failedGates = gates.filter { it.passed != true }.map { "${it.name}: ${it.detail}" },
            flags = flags.map { it.text }, confirmations = cross.confirmations, reason = reason,
            engineVersion = ENGINE_VERSION, configHash = cfg.hash,
        )
    }
}
