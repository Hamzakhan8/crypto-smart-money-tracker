package com.smartmoney.screener.ui.history

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.smartmoney.engine.screener.Tier
import com.smartmoney.screener.container
import com.smartmoney.screener.data.GapEntity
import com.smartmoney.screener.data.HitEntity
import com.smartmoney.screener.ui.Badge
import com.smartmoney.screener.ui.EmptyState
import com.smartmoney.screener.ui.Fmt
import com.smartmoney.screener.ui.Palette
import com.smartmoney.screener.ui.UnprovenBadge
import com.smartmoney.screener.ui.moveColor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Every closed candle with an unusual move (passed or rejected, with the reason) and every data gap. Kept 30 days.
 * Outcomes (price after 5/15/30/60 minutes) are not tracked in Track A.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen() {
    val c = LocalContext.current.container
    val dao = remember { c.db.dao() }
    val hits by dao.hits(500).collectAsStateWithLifecycle(initialValue = null)
    val gaps by dao.gaps(200).collectAsStateWithLifecycle(initialValue = null)
    var tab by remember { mutableIntStateOf(0) }
    var tierFilter by remember { mutableStateOf<Tier?>(null) }
    var confirmClear by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("History", fontWeight = FontWeight.SemiBold) },
            actions = { IconButton(onClick = { confirmClear = true }) { Icon(Icons.Default.Delete, contentDescription = "Clear history") } },
        )
        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Moves (${hits?.size ?: 0})") })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Data gaps (${gaps?.size ?: 0})") })
        }
        if (tab == 0) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = tierFilter == null, onClick = { tierFilter = null }, label = { Text("All") })
                FilterChip(selected = tierFilter == Tier.CONFIRMED, onClick = { tierFilter = Tier.CONFIRMED }, label = { Text("Confirmed") })
                FilterChip(selected = tierFilter == Tier.REJECTED, onClick = { tierFilter = Tier.REJECTED }, label = { Text("Rejected") })
            }
            val list = hits?.filter { tierFilter == null || it.tier == tierFilter!!.name }
            when {
                list == null -> Unit
                list.isEmpty() -> EmptyState(
                    "Nothing logged yet",
                    "When a candle closes with an unusual move (on any scanned coin), it is logged here, whether it passed the gates or not. Turn on background scanning in Settings to log while the app is closed.",
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(list, key = { it.id }) { HitItem(it); HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) }
                }
            }
        } else {
            val list = gaps
            when {
                list == null -> Unit
                list.isEmpty() -> EmptyState("No data gaps", "Times when an exchange was offline or the app was not scanning show here, so statistics never silently skip them.")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(list, key = { it.id }) { GapItem(it); HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) }
                }
            }
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Clear history?") },
            text = { Text("This deletes every logged move and data gap on this phone. It cannot be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    scope.launch { withContext(Dispatchers.IO) { dao.clearHits(); dao.clearGaps() } }
                }) { Text("Delete", color = Palette.Down) }
            },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun HitItem(h: HitEntity) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(h.canonical, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(6.dp))
            Text("${h.exchange.lowercase().replaceFirstChar { it.uppercase() }} ${h.market.lowercase()} · ${h.timeframe}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Text(Fmt.dateTime(h.candleOpenTime), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(3.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            val confirmed = h.tier == Tier.CONFIRMED.name
            Badge(if (confirmed) "Confirmed" else "Rejected", if (confirmed) Palette.Up else Palette.Off, filled = confirmed)
            h.label?.let { Spacer(Modifier.width(6.dp)); Text(it, fontSize = 12.sp) }
            Spacer(Modifier.width(6.dp))
            UnprovenBadge()
            Spacer(Modifier.weight(1f))
            Text("${Fmt.pct(h.move)}  ${Fmt.num(h.zMove, 1)} ATR", color = moveColor(h.move), fontSize = 13.sp)
        }
        Text(
            listOfNotNull(
                "price ${Fmt.price(h.price)}",
                "vol ${Fmt.times(h.relVolume)}",
                "BTC-adj ${Fmt.pct(h.residual)}",
                h.oiChange?.let { "OI ${Fmt.pct(it)}" },
                h.fundingRate?.let { "funding ${Fmt.pct(it, digits = 3)}" },
                h.invalidation?.let { "invalidation ${Fmt.price(it)}" },
            ).joinToString(" · "),
            fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (h.failedGates.isNotBlank()) Text("Failed: ${h.failedGates.replace("\n", "; ")}", fontSize = 11.sp, color = Palette.Down)
        if (h.flags.isNotBlank()) Text("⚠ ${h.flags.replace("\n", "; ")}", fontSize = 11.sp, color = Palette.Amber)
        Text("engine ${h.engineVersion} · config ${h.configHash}", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun GapItem(g: GapEntity) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row {
            Text(g.feed, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            Text(Fmt.duration(g.toTime - g.fromTime), color = Palette.Amber)
        }
        Text("${Fmt.dateTime(g.fromTime)} to ${Fmt.dateTime(g.toTime)} · ${g.reason}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
