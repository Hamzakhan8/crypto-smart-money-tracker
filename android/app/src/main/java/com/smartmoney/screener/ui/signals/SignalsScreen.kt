package com.smartmoney.screener.ui.signals

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import com.smartmoney.screener.AppContainer
import com.smartmoney.screener.container
import com.smartmoney.screener.data.HitEntity
import com.smartmoney.screener.data.Paper
import com.smartmoney.screener.ui.ActionChip
import com.smartmoney.screener.ui.Badge
import com.smartmoney.screener.ui.EmptyState
import com.smartmoney.screener.ui.FeedStatusDialog
import com.smartmoney.screener.ui.Fmt
import com.smartmoney.screener.ui.Palette
import com.smartmoney.screener.ui.StatusDots
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

/** One v0.3 signal: coin, direction, entry, stop, target, score, label, holdout stats, live paper result. */
data class SignalCard(
    val key: InstrumentKey,
    val action: String,
    val timeframe: String,
    val time: Long,
    val entry: Double?,
    val target: Double?,
    val stop: Double?,
    val score: Int?,
    val live: Boolean,
    val paperStatus: String?,
    val paperNet: Double?,
)

data class SignalsUi(
    val live: List<SignalCard> = emptyList(),
    val recent: List<SignalCard> = emptyList(),
    val feeds: List<FeedStatus> = emptyList(),
    val running: Boolean = false,
    val paper: Paper.Summary = Paper.Summary(0, Double.NaN, Double.NaN),
    val minScore: Int = 75,
)

class SignalsViewModel(c: AppContainer) : ViewModel() {
    private val dao = c.db.dao()
    private val ticks = flow {
        while (true) {
            emit(System.currentTimeMillis())
            delay(60_000)
        }
    }

    @OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
    val ui: StateFlow<SignalsUi> = combine(
        c.controller.snapshot.sample(1_000).onStart { emit(c.controller.snapshot.value) },
        ticks.flatMapLatest { now -> dao.signalsSince(now - 24 * 3_600_000L) },
        ticks.flatMapLatest { now -> dao.paperResults(now - 30L * 24 * 3_600_000L) },
        c.settings.settings,
    ) { s, hits, paper, settings ->
        val live = s.rows.filter { it.isSignal }.sortedByDescending { it.score ?: 0 }.map { liveCard(it) }
        val liveIds = live.map { it.key to it.time }.toSet()
        val recent = hits.mapNotNull { h ->
            val key = InstrumentKey(
                Exchange.entries.firstOrNull { it.name == h.exchange } ?: return@mapNotNull null,
                Market.entries.firstOrNull { it.name == h.market } ?: return@mapNotNull null,
                h.canonical,
            )
            val tf = Timeframe.fromLabel(h.timeframe) ?: Timeframe.M5
            val close = h.candleOpenTime + tf.millis
            if ((key to close) in liveIds) null else recentCard(h, key, close)
        }
        SignalsUi(live, recent, s.feeds, s.running, Paper.summarize(paper), settings.minScore)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SignalsUi())

    private fun liveCard(r: ScreenerRow) = SignalCard(
        key = r.instrument.key, action = r.label!!.text, timeframe = r.timeframe.label,
        time = (r.closed?.candleOpenTime ?: 0L) + r.timeframe.millis,
        entry = r.plan?.entry, target = r.plan?.target, stop = r.plan?.stop, score = r.score, live = true,
        paperStatus = null, paperNet = null,
    )

    private fun recentCard(h: HitEntity, key: InstrumentKey, close: Long) = SignalCard(
        key = key, action = h.label ?: "", timeframe = h.timeframe, time = close, entry = h.price, target = h.target,
        stop = h.stop, score = h.score, live = false, paperStatus = h.paperStatus, paperNet = h.paperNet,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignalsScreen(onOpen: (InstrumentKey) -> Unit) {
    val c = LocalContext.current.container
    val vm: SignalsViewModel = viewModel(factory = viewModelFactory { initializer { SignalsViewModel(c) } })
    val ui by vm.ui.collectAsStateWithLifecycle()
    var showStatus by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("Signals", fontWeight = FontWeight.SemiBold) }, actions = { StatusDots(ui.feeds) { showStatus = true } })
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 12.dp)) {
            item { PaperCard(ui.paper) }
            item {
                Text(
                    "EXPERIMENTAL: a signal is a confirmed unusual move whose score is at least ${ui.minScore} (the share of 8 checks that pass, all weighted equally). No setup has passed a holdout test yet. Not trading advice.",
                    fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp),
                )
            }
            if (ui.live.isEmpty() && ui.recent.isEmpty()) {
                item {
                    Column(Modifier.fillMaxWidth().height(320.dp)) {
                        EmptyState(
                            if (ui.running) "No signals right now" else "Starting the scanner",
                            "Signals are rare by design: a candle must close with an unusual move, pass every check, and score at least ${ui.minScore}. Keep the app open or turn on background scanning in Settings.",
                        )
                    }
                }
            }
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
    if (showStatus) FeedStatusDialog(ui.feeds) { showStatus = false }
}

@Composable
private fun PaperCard(p: Paper.Summary) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text("Live paper results (last 30 days)", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            if (p.n == 0) {
                Text("No finished signals yet. Each signal is scored after 30 minutes: target first = win, stop first = loss.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Stat("Signals", p.n.toString(), MaterialTheme.colorScheme.onSurface)
                    Stat("Win rate", Fmt.pct(p.winRate, digits = 1, signed = false), MaterialTheme.colorScheme.onSurface)
                    Stat("Avg net", Fmt.pct(p.avgNet), moveColor(p.avgNet))
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(
                "Backtest for comparison (v0.2 rule, Binance perps 2025-01 to 2026-06, ${"%,d".format(Paper.BACKTEST_EVENTS)} trades): ${Fmt.pct(Paper.BACKTEST_WIN_RATE, 1, false)} wins, ${Fmt.pct(Paper.BACKTEST_NET)} per trade after costs. The v0.3 score itself has no backtest yet.",
                fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            p.verdict?.let { Text(it, fontSize = 12.sp, color = if (it.startsWith("Worse")) Palette.Down else Palette.Amber, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}

@Composable
private fun Stat(label: String, value: String, color: Color) {
    Column {
        Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = color)
    }
}

@Composable
private fun Header(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 14.dp, top = 12.dp, bottom = 4.dp))
}

@Composable
private fun SignalItem(s: SignalCard, onOpen: (InstrumentKey) -> Unit) {
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
                    Text("${s.key.exchange.label} ${s.key.market.label.lowercase()} · ${s.timeframe} · ${Fmt.time(s.time)}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("Score ${s.score ?: "-"}", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Badge("EXPERIMENTAL", Palette.Amber)
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Price("Entry", s.entry, MaterialTheme.colorScheme.onSurface)
                Price("Stop", s.stop, Palette.Down)
                Price("Target", s.target, Palette.Up)
            }
            Spacer(Modifier.height(6.dp))
            val paper = when (s.paperStatus) {
                null -> if (s.live) "open (scored after 30 min)" else "open"
                "UNTRACKED" -> "not tracked (app was closed)"
                else -> "${s.paperStatus} ${Fmt.pct(s.paperNet)}"
            }
            Text(
                "Holdout: not tested (n = 0) · Paper: $paper",
                fontSize = 11.sp,
                color = when (s.paperStatus) { "WIN" -> Palette.Up; "LOSS" -> Palette.Down; else -> MaterialTheme.colorScheme.onSurfaceVariant },
            )
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
