package com.smartmoney.engine.net

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

interface WsListener {
    fun onOpen()
    fun onMessage(text: String)
    fun onClosed(code: Int, reason: String)
    fun onFailure(error: Throwable)
}

interface WsConnection {
    fun send(text: String): Boolean
    fun close()
}

/** Opens WebSocket connections. Tests replace it with a scripted fake. */
fun interface WsTransport {
    fun connect(url: String, listener: WsListener): WsConnection
}

/**
 * OkHttp WebSocket. OkHttp answers the server's ping frames with pong frames automatically, which is the
 * heartbeat Binance asks for; Bybit and OKX need text pings, which the connection manager sends.
 */
class OkHttpWsTransport(private val client: OkHttpClient) : WsTransport {
    override fun connect(url: String, listener: WsListener): WsConnection {
        val ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = listener.onFailure(t)
        })
        return object : WsConnection {
            override fun send(text: String): Boolean = ws.send(text)
            override fun close() {
                ws.close(1000, "client close")
            }
        }
    }
}
