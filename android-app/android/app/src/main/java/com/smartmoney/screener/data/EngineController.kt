package com.smartmoney.screener.data

import com.smartmoney.engine.screener.EngineListener
import com.smartmoney.engine.screener.EngineSnapshot
import com.smartmoney.engine.screener.GapRecord
import com.smartmoney.engine.screener.HitRecord
import com.smartmoney.engine.screener.ScreenerEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Writes every logged hit and data gap to the history database (and drops entries older than 30 days). */
class HistoryRecorder(
    private val dao: HistoryDao,
    private val scope: CoroutineScope,
    private val notifier: SignalNotifier? = null,
) : EngineListener {
    override fun onHit(hit: HitRecord) {
        scope.launch(Dispatchers.IO) { dao.insertHit(HitEntity.from(hit)) }
        if (hit.isSignal && notifier != null) scope.launch { notifier.onSignal(hit) }
    }

    override fun onGap(gap: GapRecord) {
        scope.launch(Dispatchers.IO) { dao.insertGap(GapEntity.from(gap)) }
    }

    /** The app was closed or not scanning: every feed is missing data. */
    fun appGap(from: Long, to: Long) {
        scope.launch(Dispatchers.IO) { dao.insertGap(GapEntity(feed = "All exchanges", fromTime = from, toTime = to, reason = "app was not scanning")) }
    }

    fun prune(now: Long) {
        scope.launch(Dispatchers.IO) {
            dao.pruneHits(now - RETENTION_MS)
            dao.pruneGaps(now - RETENTION_MS)
        }
    }

    companion object {
        const val RETENTION_MS = 30L * 24 * 3_600_000L
    }
}

/**
 * Runs the engine while someone needs it: the visible screen ("ui") or the background service ("service"). When the
 * last user leaves, scanning stops after a short grace period (so screen rotation does not restart every feed).
 * The time the app was last scanning is saved, and the time it was not is logged as a data gap.
 */
class EngineController(
    private val engine: ScreenerEngine,
    private val settings: SettingsRepository,
    private val recorder: HistoryRecorder,
    private val dao: HistoryDao,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    val snapshot: StateFlow<EngineSnapshot> = engine.snapshot

    private val users = HashSet<String>()
    private var runJob: Job? = null
    private var stopJob: Job? = null

    @Synchronized
    fun acquire(user: String) {
        users += user
        stopJob?.cancel()
        stopJob = null
        if (runJob == null) runJob = scope.launch { run() }
    }

    @Synchronized
    fun release(user: String) {
        users -= user
        if (users.isEmpty() && runJob != null && stopJob == null) {
            stopJob = scope.launch {
                delay(GRACE_MS)
                stopNow()
            }
        }
    }

    suspend fun refreshDepth(key: com.smartmoney.engine.model.InstrumentKey) = engine.refreshDepth(key)
    suspend fun candles(key: com.smartmoney.engine.model.InstrumentKey) = engine.candles(key)

    @Synchronized
    private fun stopNow() {
        if (users.isNotEmpty()) return
        runJob?.cancel()
        runJob = null
        stopJob = null
        engine.stop()
        val t = now()
        scope.launch { settings.setLastAlive(t) }
    }

    private suspend fun run() {
        val first = settings.settings.first()
        val t = now()
        first.lastAliveAt?.let { last -> if (t - last > 2 * 60_000L) recorder.appGap(last, t) }
        recorder.prune(t)
        engine.start(first.toEngineConfig())
        scope.launch {
            settings.settings.map { it.toEngineConfig() }.distinctUntilChanged().drop(1).collect { engine.updateConfig(it) }
        }.also { cfgJob ->
            try {
                while (scope.isActive) {
                    settings.setLastAlive(now())
                    try {
                        val s = settings.settings.first()
                        val cfg = s.toEngineConfig()
                        Paper.update(dao, { engine.candles(it) }, cfg.timeframe, { e, m -> cfg.takerFee(e, m) }, now())
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // Paper scoring must never stop the scanner; it retries next minute.
                    }
                    delay(60_000)
                }
            } finally {
                cfgJob.cancel()
            }
        }
    }

    companion object {
        const val GRACE_MS = 15_000L
    }
}
