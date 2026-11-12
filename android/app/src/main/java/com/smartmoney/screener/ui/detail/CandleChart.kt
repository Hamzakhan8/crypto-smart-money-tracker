package com.smartmoney.screener.ui.detail

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.smartmoney.engine.model.Candle
import com.smartmoney.screener.ui.Fmt
import com.smartmoney.screener.ui.Palette

/** Candlesticks of the selected exchange, with the invalidation level as a dashed amber line. */
@Composable
fun CandleChart(candles: List<Candle>, invalidation: Double?, modifier: Modifier = Modifier) {
    if (candles.size < 2) {
        Box(modifier.fillMaxWidth().height(200.dp), contentAlignment = Alignment.Center) {
            Text("Waiting for candles…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    val last = candles.last()
    val desc = "Candle chart, ${candles.size} candles, last close ${Fmt.price(last.close)}" + (invalidation?.let { ", invalidation ${Fmt.price(it)}" } ?: "")
    val grid = MaterialTheme.colorScheme.outlineVariant
    Canvas(modifier.fillMaxWidth().height(220.dp).semantics { contentDescription = desc }) {
        val hi = maxOf(candles.maxOf { it.high }, invalidation ?: Double.MIN_VALUE)
        val lo = minOf(candles.minOf { it.low }, invalidation ?: Double.MAX_VALUE)
        val range = (hi - lo).takeIf { it > 0 } ?: 1.0
        val pad = 8f
        fun y(p: Double) = (pad + (size.height - 2 * pad) * (1 - (p - lo) / range)).toFloat()
        for (i in 0..3) {
            val gy = pad + (size.height - 2 * pad) * i / 3f
            drawLine(grid, Offset(0f, gy), Offset(size.width, gy), strokeWidth = 1f)
        }
        val slot = size.width / candles.size
        val body = (slot * 0.6f).coerceAtLeast(1f)
        candles.forEachIndexed { i, c ->
            val color = when {
                !c.closed -> Palette.Blue
                c.close >= c.open -> Palette.Up
                else -> Palette.Down
            }
            val cx = i * slot + slot / 2
            drawLine(color, Offset(cx, y(c.high)), Offset(cx, y(c.low)), strokeWidth = 1.5f)
            val top = y(maxOf(c.open, c.close))
            val bottom = y(minOf(c.open, c.close))
            drawRect(color, topLeft = Offset(cx - body / 2, top), size = Size(body, (bottom - top).coerceAtLeast(1.5f)))
        }
        invalidation?.let {
            val iy = y(it)
            drawLine(Palette.Amber, Offset(0f, iy), Offset(size.width, iy), strokeWidth = 2f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 8f)))
        }
    }
}
