package com.smartmoney.engine

import com.smartmoney.engine.features.CandleSeries
import com.smartmoney.engine.net.HttpGet
import com.smartmoney.engine.net.HttpResponse
import com.smartmoney.engine.stream.StreamEvent
import com.smartmoney.engine.util.J
import kotlinx.serialization.json.JsonElement

/**
 * Real responses recorded from the exchanges on 2026-11-12 (engine/src/test/resources/recorded/<exchange>/, each
 * folder's MANIFEST.json lists source URL, capture time, rows and sha256).
 */
object Fixtures {
    fun text(path: String): String =
        Fixtures::class.java.getResource("/recorded/$path")?.readText() ?: error("missing fixture $path")

    fun json(path: String): JsonElement = J.parse(text(path))

    fun lines(path: String): List<String> = text(path).lines().filter { it.isNotBlank() }

    data class Replay(val events: List<StreamEvent>, val malformed: Int) {
        val candles get() = events.filterIsInstance<StreamEvent.CandleUpdate>()
        val pongs get() = events.count { it is StreamEvent.Pong }
        val acks get() = events.count { it is StreamEvent.Ack }
        val errors get() = events.filterIsInstance<StreamEvent.Error>()

        /** Merges every candle update in arrival order, as the live feed does. */
        fun series(): Map<String, CandleSeries> {
            val out = HashMap<String, CandleSeries>()
            for (u in candles) out[u.nativeSymbol] = (out[u.nativeSymbol] ?: CandleSeries()).merge(u.candles)
            return out
        }
    }

    /** Feeds every recorded WebSocket line to [parse], counting lines it rejects. */
    fun replay(path: String, parse: (String) -> StreamEvent): Replay {
        val events = ArrayList<StreamEvent>()
        var bad = 0
        for (l in lines(path)) {
            try {
                events += parse(l)
            } catch (e: Exception) {
                bad += 1
            }
        }
        return Replay(events, bad)
    }
}

/** Serves recorded bodies by URL substring; records every URL asked for. */
class FakeHttp(private val routes: List<Pair<String, HttpResponse>>) : HttpGet {
    val calls = ArrayList<String>()
    override suspend fun get(url: String): HttpResponse {
        calls += url
        return routes.firstOrNull { url.contains(it.first) }?.second ?: HttpResponse(404, """{"msg":"no route"}""", emptyMap())
    }

    companion object {
        fun ok(body: String, headers: Map<String, String> = emptyMap()) = HttpResponse(200, body, headers)
    }
}
