package com.smartmoney.screener.ui.signals

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.InstrumentKey
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.screener.FeedStatus
import com.smartmoney.engine.screener.ScreenerRow
import com.smartmoney.engine.screener.SignalLabel
import com.smartmoney.engine.screener.Tier
import com.smartmoney.screener.AppContainer
import com.smartmoney.screener.container
import com.smartmoney.screener.data.HitEntity
import com.smartmoney.screener.ui.ActionChip
import com.smartmoney.screener.ui.EmptyState
import com.smartmoney.screener.ui.FeedStatusDialog
import com.smartmoney.screener.ui.Fmt
import com.smartmoney.screener.ui.Palette
import com.smartmoney.screener.ui.SIGNAL_RULE
import com.smartmoney.screener.ui.StatusDots
import com.smartmoney.screener.ui.UnprovenBadge
import com.smartmoney.screener.ui.actionColor
import com.smartmoney.screener.ui.moveColor
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.flow.stateIn

/** One signal card: live (from the scanner now) or recent (from the history log). */
data class SignalCard(
    val key: InstrumentKey,
    val action: String,
    val timeframe: String,
    val time: Long,
    val entry: Double?,
    val target: Double?,
    val stop: Double?,
    val now: Double?,
    val live: Boolean,
    val reason: String,
    val windowEnds: Long,
) {
    /** Move since the signal in the signal's direction (positive = going the right way so far). */
    val sinceSignal: Double?
        get() {
            val e = entry ?: return null
            val n = now ?: return null
            if (e <= 0) return null
            return (if (action == SignalLabel.SHORT.text) -1 else 1) * (n / e - 1)
        }
}

data class SignalsUi(val live: List<SignalCard> = emptyList(), val recent: List<SignalCard> = emptyList(), val feeds: List<FeedStatus> = emptyList(), val running: Boolean = false)

class SignalsViewModel(c: AppContainer) : ViewModel() {
    private val dao = c.db.dao()
    private val minuteTicks = flow {
        while (true) {
            emit(System.currentTimeMillis())
            delay(60_000)
        }
    }

    @OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
    val ui: StateFlow<SignalsUi> = combine(
        c.controller.snapshot.sample(1_000).onStart { emit(c.controller.snapshot.value) },
        minuteTicks.flatMapLatest { now -> dao.signalsSince(now - 24 * 3_600_000L) },
    ) { s, hits ->
        val byKey = s.rows.associateBy { it.instrument.key }
        val live = s.rows.filter { it.tier == Tier.CONFIRMED && it.label != null }
            .sortedByDescending { kotlin.math.abs(it.closed?.zMove ?: 0.0) }
            .map { liveCard(it) }
        val liveIds = live.map { it.key to it.time }.toSet()
        val recent = hits.mapNotNull { h ->
            val key = InstrumentKey(
                Exchange.entries.firstOrNull { it.name == h.exchange } ?: return@mapNotNull null,
                Market.entries.firstOrNull { it.name == h.market } ?: return@mapNotNull null,
                h.canonical,
            )
            val tf = Timeframe.fromLabel(h.timeframe) ?: Timeframe.M5
            val closeTime = h.candleOpenTime + tf.millis
            if ((key to closeTime) in liveIds) return@mapNotNull null
            recentCard(h, key, tf, byKey[key]?.price)
        }
        SignalsUi(live, recent, s.feeds, s.running)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SignalsUi())

    private fun liveCard(r: ScreenerRow): SignalCard {
        val close = (r.closed?.candleOpenTime ?: 0L) + r.timeframe.millis
        return SignalCard(
            key = r.instrument.key, action = r.label!!.text, timeframe = r.timeframe.label, time = close,
            entry = r.plan?.entry, target = r.plan?.target, stop = r.plan?.stop, now = r.price, live = true,
            reason = r.reason, windowEnds = close + (r.plan?.horizonMinutes ?: 30) * 60_000L,
        )
    }

    private fun recentCard(h: HitEntity, key: InstrumentKey, tf: Timeframe, now: Double?): SignalCard {
        val close = h.candleOpenTime + tf.millis
        return SignalCard(
            key = key, action = h.label ?: "", timeframe = h.timeframe, time = close, entry = h.price,
            target = h.target, stop = h.stop, now = now, live = false, reason = h.reason, windowEnds = close + 30 * 60_000L,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignalsScreen(onOpen: (InstrumentKey) -> Unit) {
    val c = LocalContext.current.container
    val vm: SignalsViewModel = viewModel(factory = viewModelFactory { initializer { SignalsViewModel(c) } })
    val ui by vm.ui.collectAsStateWithLifecycle()
    var showStatus by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Signals", fontWeight = FontWeight.SemiBold) },
            actions = { StatusDots(ui.feeds) { showStatus = true } },
        )
        Card(
            colors = CardDefaults.cardColors(containerColor = Palette.Amber.copy(alpha = 0.12f)),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        ) {
            Column(Modifier.padding(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    UnprovenBadge()
                    Spacer(Modifier.width(6.dp))
                    Text("Not tested on past data yet. Not trading advice.", fontSize = 12.sp, color = Palette.Amber, fontWeight = FontWeight.SemiBold)
                }
                Text(SIGNAL_RULE, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            }
        }
        if (ui.live.isEmpty() && ui.recent.isEmpty()) {
            EmptyState(
                if (ui.running) "No signals right now" else "Starting the scanner",
                "No coin has closed a candle with an unusual move that passed every check in the last 24 hours. The app keeps scanning while it is open; turn on background scanning in Settings to catch signals while it is closed.",
            )
        } else {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 12.dp)) {
                if (ui.live.isNotEmpty()) {
                    item { Header("Live now (${ui.live.size})") }
                    items(ui.live, key = { "live-${it.key}-${it.time}" }) { SignalItem(it, onOpen) }
                }
                if (ui.recent.isNotEmpty()) {
                    item { Header("Last 24 hours (${ui.recent.size})") }
                    items(ui.recent, key = { "rec-${it.key}-${it.time}-${it.action}" }) { SignalItem(it, onOpen) }
                }
            }
        }
    }
    if (showStatus) FeedStatusDialog(ui.feeds) { showStatus = false }
}

@Composable
private fun Header(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 14.dp, top = 12.dp, bottom = 4.dp))
}

@Composable
private fun SignalItem(s: SignalCard, onOpen: (InstrumentKey) -> Unit) {
    val now = System.currentTimeMillis()
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp).clickable { onOpen(s.key) },
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ActionChip(s.action, actionColor(s.action), large = true)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(s.key.canonical, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                    Text("${s.key.exchange.label} ${s.key.market.label.lowercase()} · ${s.timeframe} · ${Fmt.time(s.time)} (${ago(now - s.time)})", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                UnprovenBadge()
            }
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Price("Entry", s.entry, MaterialTheme.colorScheme.onSurface)
                Price("Target", s.target, Palette.Up)
                Price("Stop", s.stop, Palette.Down)
                Price("Now", s.now, MaterialTheme.colorScheme.onSurface)
            }
            Spacer(Modifier.height(6.dp))
            val since = s.sinceSignal
            val window = if (now < s.windowEnds) "plan window open until ${Fmt.time(s.windowEnds)}" else "30-minute plan window over"
            Text(
                "Since the signal: ${Fmt.pct(since)} · $window",
                fontSize = 12.sp, color = if (since == null) MaterialTheme.colorScheme.onSurfaceVariant else moveColor(since),
            )
            Text(s.reason, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
        }
    }
}

@Composable
private fun Price(label: String, value: Double?, color: Color) {
    Column {
        Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(Fmt.price(value), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = color)
    }
}

private fun ago(ms: Long): String = when {
    ms < 60_000 -> "just now"
    ms < 3_600_000 -> "${ms / 60_000} min ago"
    else -> "${ms / 3_600_000} h ago"
}
