package com.smartmoney.engine

import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.screener.EngineConfig
import com.smartmoney.engine.screener.EngineListener
import com.smartmoney.engine.screener.GapRecord
import com.smartmoney.engine.screener.HitRecord
import com.smartmoney.engine.screener.RowBuilder
import com.smartmoney.engine.screener.Tier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.abs

/**
 * Live check (needs internet, not a unit test): runs the real engine against Binance, Bybit and OKX for a few minutes
 * and prints what each feed sees. Run: ./gradlew :engine:liveSmoke -Pminutes=3 [-Ptf=1m]
 * It prints only what it observed; it measures nothing about signal quality.
 */
fun main(args: Array<String>) = runBlocking {
    val minutes = args.getOrNull(0)?.toDoubleOrNull() ?: 3.0
    val tf = args.getOrNull(1)?.let { Timeframe.fromLabel(it) } ?: Timeframe.M1
    val hits = CopyOnWriteArrayList<HitRecord>()
    val gaps = CopyOnWriteArrayList<GapRecord>()
    val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    val engine = Engines.create(scope, object : EngineListener {
        override fun onHit(hit: HitRecord) {
            hits += hit
            println("HIT ${hit.tier} ${hit.exchange} ${hit.market} ${hit.canonical} move=${hit.move?.let { RowBuilder.pct(it) }} z=${hit.zMove?.let { RowBuilder.fmt1(it) }} failed=${hit.failedGates.map { it.substringBefore(":") }}")
        }

        override fun onGap(gap: GapRecord) {
            gaps += gap
            println("GAP ${gap.feed} ${(gap.to - gap.from) / 1000}s: ${gap.reason}")
        }
    })
    val cfg = EngineConfig(timeframe = tf, universeSize = 15)
    println("engine ${com.smartmoney.engine.screener.ENGINE_VERSION} config ${cfg.hash}, ${tf.label}, ${minutes} min")
    engine.start(cfg)
    val end = System.currentTimeMillis() + (minutes * 60_000).toLong()
    while (System.currentTimeMillis() < end) {
        delay(30_000)
        val s = engine.snapshot.value
        println("--- ${java.time.Instant.ofEpochMilli(s.time)} rows=${s.rows.size}")
        for (f in s.feeds) {
            val rows = s.rows.filter { it.instrument.feed == f.id }
            val ready = rows.count { it.closed?.zMove != null }
            println("  ${f.id}: ${f.phase.label} ${f.message ?: ""} latency=${f.latencyMs}ms universe=${f.universe} rows=${rows.size} withFeatures=$ready malformed=${f.malformed} reconnects=${f.reconnects}")
        }
        s.rows.filter { it.closed?.zMove != null }.sortedByDescending { abs(it.closed!!.zMove!!) }.take(3).forEach {
            println("  top: ${it.instrument.key} tier=${it.tier.label} ${it.reason.take(140)}")
        }
    }
    val s = engine.snapshot.value
    engine.stop()
    scope.cancel()
    println("=== SUMMARY")
    for (f in s.feeds) {
        val rows = s.rows.filter { it.instrument.feed == f.id }
        println("${f.id}: ${f.phase.label}; rows ${rows.size}; with ${tf.label} features ${rows.count { it.closed?.zMove != null }}; perps with OI change ${rows.count { it.perp?.oiChange != null }}; with funding ${rows.count { it.perp?.fundingRate != null }}; malformed ${f.malformed}")
    }
    println("hits logged: ${hits.size} (confirmed ${hits.count { it.tier == Tier.CONFIRMED }}, rejected ${hits.count { it.tier == Tier.REJECTED }}); gaps: ${gaps.size}")
}
