package com.smartmoney.engine.net

import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class HttpResponse(val code: Int, val body: String, val headers: Map<String, String>) {
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

/** The only thing adapters need from HTTP: a GET. Tests replace it with recorded responses. */
fun interface HttpGet {
    suspend fun get(url: String): HttpResponse
}

class OkHttpGet(private val client: OkHttpClient) : HttpGet {
    override suspend fun get(url: String): HttpResponse = suspendCancellableCoroutine { cont ->
        val call = client.newCall(Request.Builder().url(url).header("Accept", "application/json").build())
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = try {
                        it.body?.string() ?: ""
                    } catch (e: IOException) {
                        if (cont.isActive) cont.resumeWithException(e)
                        return
                    }
                    val headers = it.headers.toMultimap().mapValues { (_, v) -> v.joinToString(",") }
                    if (cont.isActive) cont.resume(HttpResponse(it.code, body, headers))
                }
            }
        })
    }
}

/** An exchange answered with an error (HTTP error or an error code in the body). */
open class ExchangeException(message: String, val httpCode: Int? = null, val exchangeCode: String? = null) : Exception(message)

/** The exchange said we are sending too much. All requests to it pause until [retryAfterMs] has passed. */
class RateLimitedException(message: String, val retryAfterMs: Long, httpCode: Int?) : ExchangeException(message, httpCode)

/**
 * Keeps requests to one exchange under its limits: a minimum gap between requests, and a full pause after the
 * exchange reports a rate limit (HTTP 429 / 418 or its own code). [now] and [sleep] are injectable for tests.
 */
class RateLimiter(
    private val minIntervalMs: Long,
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private val mutex = Mutex()
    private var nextAllowedAt = 0L
    private var pausedUntil = 0L

    suspend fun acquire() {
        mutex.withLock {
            val t = now()
            val wait = maxOf(nextAllowedAt, pausedUntil) - t
            if (wait > 0) sleep(wait)
            nextAllowedAt = maxOf(now(), t) + minIntervalMs
        }
    }

    fun pause(ms: Long) {
        pausedUntil = maxOf(pausedUntil, now() + ms)
    }

    val pausedUntilMillis: Long get() = pausedUntil
}

/** Parses a Retry-After header (seconds). Falls back to [defaultMs]. */
fun retryAfterMs(response: HttpResponse, defaultMs: Long): Long {
    val s = response.header("Retry-After")?.trim()?.toLongOrNull() ?: return defaultMs
    return (s * 1000L).coerceIn(1_000L, 10 * 60_000L)
}
