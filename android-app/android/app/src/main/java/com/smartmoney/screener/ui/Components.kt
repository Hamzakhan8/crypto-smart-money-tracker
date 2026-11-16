package com.smartmoney.screener.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.screener.FeedPhase
import com.smartmoney.engine.screener.FeedStatus
import com.smartmoney.engine.screener.SignalLabel
import com.smartmoney.engine.screener.Tier

fun phaseColor(p: FeedPhase): Color = when (p) {
    FeedPhase.LIVE -> Palette.Up
    FeedPhase.DEGRADED, FeedPhase.STARTING -> Palette.Amber
    FeedPhase.OFFLINE -> Palette.Down
    FeedPhase.DISABLED -> Palette.Off
}

fun moveColor(x: Double?): Color = when {
    x == null || x == 0.0 -> Palette.Muted
    x > 0 -> Palette.Up
    else -> Palette.Down
}

@Composable
fun Dot(color: Color, size: Int = 8) {
    Box(Modifier.size(size.dp).clip(CircleShape).background(color))
}

/** One dot per exchange (worst of its spot and perp feeds) with the latency. Tap for details. */
@Composable
fun StatusDots(feeds: List<FeedStatus>, onClick: () -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        for (ex in Exchange.entries) {
            val fs = feeds.filter { it.id.exchange == ex }
            val phase = when {
                fs.isEmpty() -> FeedPhase.DISABLED
                fs.all { it.phase == FeedPhase.LIVE } -> FeedPhase.LIVE
                fs.any { it.phase == FeedPhase.LIVE || it.phase == FeedPhase.DEGRADED } -> FeedPhase.DEGRADED
                fs.any { it.phase == FeedPhase.STARTING } -> FeedPhase.STARTING
                else -> FeedPhase.OFFLINE
            }
            val latency = fs.mapNotNull { it.latencyMs }.maxOrNull()
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.semantics { contentDescription = "${ex.label} ${phase.label}${latency?.let { ", $it milliseconds" } ?: ""}" },
            ) {
                Dot(phaseColor(phase))
                Spacer(Modifier.width(4.dp))
                Column {
                    Text(ex.label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface)
                    Text(latency?.let { "${it}ms" } ?: phase.label, fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
fun FeedStatusDialog(feeds: List<FeedStatus>, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        title = { Text("Exchange connections") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (feeds.isEmpty()) Text("The scanner is starting.")
                for (f in feeds) {
                    Row(verticalAlignment = Alignment.Top) {
                        Box(Modifier.padding(top = 5.dp)) { Dot(phaseColor(f.phase)) }
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text("${f.id}: ${f.phase.label}", fontWeight = FontWeight.SemiBold)
                            Text(
                                listOfNotNull(
                                    f.message,
                                    "${f.universe} coins",
                                    f.latencyMs?.let { "latency $it ms" },
                                    f.lastDataAt?.let { "last data ${Fmt.time(it)}" },
                                    if (f.reconnects > 0) "${f.reconnects} reconnects" else null,
                                    if (f.malformed > 0) "${f.malformed} unreadable messages skipped" else null,
                                ).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                Text(
                    "An exchange that is blocked or down shows red; the others keep running.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
    )
}

@Composable
fun Badge(text: String, color: Color, filled: Boolean = false) {
    Box(
        Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(if (filled) color.copy(alpha = 0.22f) else Color.Transparent)
            .then(if (filled) Modifier else Modifier.background(color.copy(alpha = 0.08f)))
            .padding(horizontal = 5.dp, vertical = 1.dp),
    ) {
        Text(text, color = color, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun UnprovenBadge() = Badge("UNPROVEN", Palette.Amber)

fun actionColor(label: SignalLabel?): Color = when (label) {
    SignalLabel.LONG, SignalLabel.BUY -> Palette.Up
    SignalLabel.SHORT -> Palette.Down
    null -> Palette.Muted
}

fun actionColor(text: String?): Color = actionColor(SignalLabel.entries.firstOrNull { it.text == text })

/** Tier and action: a solid LONG / SHORT / BUY chip when confirmed, "Watch: LONG?" while the candle is open. */
@Composable
fun TierBadge(tier: Tier, label: SignalLabel?) {
    when {
        tier == Tier.NONE -> return
        tier == Tier.CONFIRMED && label != null -> ActionChip(label.text, actionColor(label))
        tier == Tier.WATCH && label != null -> Badge("Watch: ${label.text}?", actionColor(label))
        tier == Tier.REJECTED -> Badge("Rejected", Palette.Off)
        else -> Badge(tier.label + if (tier == Tier.CONFIRMED) " · falling" else "", Palette.Muted)
    }
}

/** A clear, solid action chip: LONG / SHORT / BUY. */
@Composable
fun ActionChip(text: String, color: Color, large: Boolean = false) {
    Box(
        Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(color)
            .padding(horizontal = if (large) 14.dp else 8.dp, vertical = if (large) 6.dp else 2.dp),
    ) {
        Text(text, color = Palette.Bg, fontSize = if (large) 18.sp else 12.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun EmptyState(title: String, body: String, action: (@Composable () -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Spacer(Modifier.size(8.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.size(16.dp))
            action()
        }
    }
}

@Composable
fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 6.dp),
    )
}

/** A label: value line; null values show "n/a". */
@Composable
fun KeyValue(key: String, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurface) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(key, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Text(value, color = valueColor, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End)
    }
}

const val DISCLAIMER = "Signals are price moves, not trading advice. Nothing in this app has been validated: every signal is unproven, and no accuracy is claimed."

const val SIGNAL_RULE = "Perps: LONG after an unusual up move, SHORT after an unusual down move. Spot: BUY after an unusual up move only (falling spot coins get no signal). A signal appears when a candle closes with a move of at least 2x its usual range and passes every check."
