package com.smartmoney.screener.ui.screener

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.InstrumentKey
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.screener.ScreenerRow
import com.smartmoney.screener.container
import com.smartmoney.screener.ui.DISCLAIMER
import com.smartmoney.screener.ui.EmptyState
import com.smartmoney.screener.ui.FeedStatusDialog
import com.smartmoney.screener.ui.Fmt
import com.smartmoney.screener.ui.Palette
import com.smartmoney.screener.ui.StatusDots
import com.smartmoney.screener.ui.TierBadge
import com.smartmoney.screener.ui.UnprovenBadge
import com.smartmoney.screener.ui.moveColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenerScreen(onOpen: (InstrumentKey) -> Unit) {
    val c = LocalContext.current.container
    val vm: ScreenerViewModel = viewModel(factory = viewModelFactory { initializer { ScreenerViewModel(c) } })
    val ui by vm.ui.collectAsStateWithLifecycle()
    var showStatus by remember { mutableStateOf(false) }
    var showFilters by remember { mutableStateOf(false) }
    val f = ui.filter

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Screener", fontWeight = FontWeight.SemiBold) },
            actions = { StatusDots(ui.feeds) { showStatus = true } },
        )
        TabRow(selectedTabIndex = if (f.market == Market.SPOT) 0 else 1) {
            Tab(selected = f.market == Market.SPOT, onClick = { vm.setFilter(f.copy(market = Market.SPOT)) }, text = { Text("Spot (${ui.spotCount})") })
            Tab(selected = f.market == Market.PERP, onClick = { vm.setFilter(f.copy(market = Market.PERP)) }, text = { Text("Perp (${ui.perpCount})") })
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            for (tf in Timeframe.entries) {
                FilterChip(selected = ui.timeframe == tf, onClick = { vm.setTimeframe(tf) }, label = { Text(tf.label) })
            }
            Spacer(Modifier.width(4.dp))
            FilterChip(
                selected = f.tier == TierFilter.SIGNALS,
                onClick = { vm.setFilter(f.copy(tier = if (f.tier == TierFilter.SIGNALS) TierFilter.ALL else TierFilter.SIGNALS)) },
                label = { Text("Signals only") },
            )
            FilterChip(
                selected = f.tier == TierFilter.MOVING,
                onClick = { vm.setFilter(f.copy(tier = if (f.tier == TierFilter.MOVING) TierFilter.ALL else TierFilter.MOVING)) },
                label = { Text("Moving only") },
            )
            OutlinedButton(onClick = { showFilters = true }) { Text(if (f.isDefault) "Filters" else "Filters *") }
        }
        OutlinedTextField(
            value = f.query,
            onValueChange = { vm.setFilter(f.copy(query = it)) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            singleLine = true,
            placeholder = { Text("Search coin, e.g. SOL") },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            trailingIcon = {
                if (f.query.isNotEmpty()) IconButton(onClick = { vm.setFilter(f.copy(query = "")) }) { Icon(Icons.Default.Clear, contentDescription = "Clear search") }
            },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        )
        Text(
            "Sorted by ${f.sort.label.lowercase()} on ${ui.timeframe.label} candles. $DISCLAIMER",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        HorizontalDivider()
        when {
            ui.allOffline -> EmptyState(
                "Can't reach any exchange",
                "Check your internet connection. If it works, the exchanges may be blocked on this network. Tap the status dots for details. The app retries on its own.",
            )
            ui.loading -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator()
                Spacer(Modifier.height(12.dp))
                Text("Loading markets and candles…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            ui.rows.isEmpty() -> EmptyState(
                "No coins match these filters",
                if (f.tier != TierFilter.ALL) "Nothing is moving unusually right now on ${ui.timeframe.label} candles." else "Try fewer filters.",
            ) { Button(onClick = { vm.setFilter(ScreenerFilter(market = f.market)) }) { Text("Reset filters") } }
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(ui.rows, key = { it.instrument.key.toString() }) { row ->
                    RowItem(row, onClick = { onOpen(row.instrument.key) })
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
    }

    if (showStatus) FeedStatusDialog(ui.feeds) { showStatus = false }
    if (showFilters) {
        ModalBottomSheet(onDismissRequest = { showFilters = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            FilterSheet(f, onChange = vm::setFilter)
        }
    }
}

@Composable
private fun RowItem(row: ScreenerRow, onClick: () -> Unit) {
    val f = row.focus
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(row.instrument.canonical, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Spacer(Modifier.width(6.dp))
            Text(row.instrument.exchange.label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.width(6.dp))
            UnprovenBadge()
            Spacer(Modifier.weight(1f))
            Text(Fmt.price(row.price), fontWeight = FontWeight.Medium)
        }
        Spacer(Modifier.height(3.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${row.timeframe.label} ${Fmt.pct(f?.move)}",
                color = moveColor(f?.move), fontSize = 13.sp, fontWeight = FontWeight.Medium,
            )
            Text(
                "  ·  ${Fmt.times(f?.zMove?.let { kotlin.math.abs(it) })} ATR  ·  vol ${Fmt.times(f?.relVolume)}  ·  BTC-adj ${Fmt.pct(f?.residual)}",
                color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            TierBadge(row.tier, row.label)
        }
        val perp = row.perp
        val extra = listOfNotNull(
            "24h ${Fmt.usd(row.ticker?.quoteVolume24h)}",
            perp?.let { "OI ${Fmt.pct(it.oiChange)}" },
            perp?.let { "funding ${Fmt.pct(it.fundingRate, digits = 3)}" },
            if (row.cross.confirmations >= 2) "${row.cross.confirmations} exchanges" else null,
        ).joinToString("  ·  ")
        Text(extra, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (row.flags.isNotEmpty() && row.tier != com.smartmoney.engine.screener.Tier.NONE) {
            Text("⚠ ${row.flags.first().text}", color = Palette.Amber, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterSheet(f: ScreenerFilter, onChange: (ScreenerFilter) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).navigationBarsPadding().padding(bottom = 16.dp)) {
        Text("Filters", style = MaterialTheme.typography.titleLarge)
        Label("Exchanges")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (e in Exchange.entries) {
                FilterChip(
                    selected = e in f.exchanges,
                    onClick = { onChange(f.copy(exchanges = if (e in f.exchanges && f.exchanges.size > 1) f.exchanges - e else f.exchanges + e)) },
                    label = { Text(e.label) },
                )
            }
        }
        Label("Tier")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (t in TierFilter.entries) FilterChip(selected = f.tier == t, onClick = { onChange(f.copy(tier = t)) }, label = { Text(t.label) })
        }
        Label("Direction")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (t in TypeFilter.entries) FilterChip(selected = f.type == t, onClick = { onChange(f.copy(type = t)) }, label = { Text(t.label) })
        }
        Label("Minimum move (in ATRs, the coin's usual candle range)")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (z in listOf(0.0, 1.0, 2.0, 3.0, 5.0)) {
                FilterChip(selected = f.minZ == z, onClick = { onChange(f.copy(minZ = z)) }, label = { Text(if (z == 0.0) "Any" else "${z.toInt()}x") })
            }
        }
        Label("Minimum 24h volume")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (v in listOf(0.0, 5e6, 20e6, 100e6)) {
                FilterChip(selected = f.minVolume24h == v, onClick = { onChange(f.copy(minVolume24h = v)) }, label = { Text(if (v == 0.0) "Any" else Fmt.usd(v)) })
            }
        }
        Label("Sort by")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (s in SortBy.entries) FilterChip(selected = f.sort == s, onClick = { onChange(f.copy(sort = s)) }, label = { Text(s.label) })
        }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = { onChange(ScreenerFilter(market = f.market)) }) { Text("Reset filters") }
    }
}

@Composable
private fun Label(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp))
}
