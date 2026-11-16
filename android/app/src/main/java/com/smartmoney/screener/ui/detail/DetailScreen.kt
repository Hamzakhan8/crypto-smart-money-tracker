package com.smartmoney.screener.ui.detail

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.smartmoney.engine.features.Breakout
import com.smartmoney.engine.features.FeatureSet
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.screener.Direction
import com.smartmoney.engine.screener.ScreenerRow
import com.smartmoney.engine.screener.Tier
import com.smartmoney.screener.container
import com.smartmoney.screener.ui.ActionChip
import com.smartmoney.screener.ui.DISCLAIMER
import com.smartmoney.screener.ui.actionColor
import com.smartmoney.screener.ui.EmptyState
import com.smartmoney.screener.ui.Fmt
import com.smartmoney.screener.ui.KeyValue
import com.smartmoney.screener.ui.Palette
import com.smartmoney.screener.ui.SectionTitle
import com.smartmoney.screener.ui.TierBadge
import com.smartmoney.screener.ui.UnprovenBadge
import com.smartmoney.screener.ui.moveColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(market: Market, canonical: String, initial: Exchange, onBack: () -> Unit) {
    val c = LocalContext.current.container
    val vm: DetailViewModel = viewModel(
        key = "$market/$canonical",
        factory = viewModelFactory { initializer { DetailViewModel(c, market, canonical, initial) } },
    )
    val ui by vm.ui.collectAsStateWithLifecycle()
    val candles by vm.candles.collectAsStateWithLifecycle()
    val checking by vm.checkingBook.collectAsStateWithLifecycle()
    val row = ui.row

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                Column {
                    Text(canonical, fontWeight = FontWeight.SemiBold)
                    Text("${market.label} · ${row?.timeframe?.label ?: ""} candles", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
            actions = { UnprovenBadge(); Spacer(Modifier.width(12.dp)) },
        )
        if (row == null) {
            EmptyState("No data for $canonical", "This coin is not in the scanned list right now (it may have dropped out of the most-traded coins, or its exchange is offline).")
            return
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp)) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (r in ui.rows) {
                    FilterChip(
                        selected = r.instrument.exchange == row.instrument.exchange,
                        onClick = { vm.select(r.instrument.exchange) },
                        label = { Text(r.instrument.exchange.label + if (r.tier != Tier.NONE) " · ${r.tier.label}" else "") },
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                Text(Fmt.price(row.price), fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(10.dp))
                Text("24h ${Fmt.pct(row.ticker?.change24hPct)}", color = moveColor(row.ticker?.change24hPct))
                Spacer(Modifier.weight(1f))
                TierBadge(row.tier, row.label)
            }
            CandleChart(candles, row.invalidation, Modifier.padding(vertical = 8.dp))

            SignalCard(row)
            Checks(row)
            Breakdown(ui.rows)
            Gates(row)
            if (row.flags.isNotEmpty()) {
                SectionTitle("Risk flags (shown, not hidden)")
                for (f in row.flags) Text("⚠ ${f.text}", color = Palette.Amber, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 2.dp))
            }
            Features(row)
            row.perp?.let { p ->
                SectionTitle("Perpetual")
                KeyValue("Mark price", Fmt.price(p.markPrice))
                KeyValue("Last vs mark", Fmt.pct(p.markDivergence, digits = 3))
                KeyValue("Funding rate (this interval)", Fmt.pct(p.fundingRate, digits = 4))
                KeyValue("Next funding", p.nextFundingTime?.let { Fmt.time(it) } ?: Fmt.NA)
                KeyValue("Open interest change", p.oiChange?.let { "${Fmt.pct(it)} in ${p.oiWindowMinutes ?: 5} min" } ?: Fmt.NA, moveColor(p.oiChange))
                KeyValue("Open interest", Fmt.usd(p.openInterestUsd))
                KeyValue("Cause label (not validated)", p.cause?.text ?: Fmt.NA)
            }
            Liquidity(row, ui.tradeSize, checking, onCheck = vm::checkBook)

            SectionTitle("Calibration")
            Text(
                "Uncalibrated. This is the Track A screener: no signal type has been validated yet, so no score, probability or hit rate is shown. Numbers above are measurements of the move, not predictions.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            Text(DISCLAIMER, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun SignalCard(row: ScreenerRow) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            val label = row.label
            val plan = row.plan
            if (label != null && (row.tier == Tier.CONFIRMED || row.tier == Tier.WATCH)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ActionChip(if (row.tier == Tier.WATCH) "${label.text}?" else label.text, actionColor(label), large = true)
                    Spacer(Modifier.width(10.dp))
                    Text(
                        if (row.tier == Tier.WATCH) "Possible ${label.text}: the candle has not closed yet" else "${label.text} signal on ${row.instrument.exchange.label} ${row.instrument.market.label.lowercase()}",
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                if (plan != null) {
                    Spacer(Modifier.height(8.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        PlanValue("Entry now", plan.entry, MaterialTheme.colorScheme.onSurface)
                        PlanValue("Target (+1 ATR)", plan.target, Palette.Up)
                        PlanValue("Stop (-1 ATR)", plan.stop, Palette.Down)
                    }
                    Text(
                        "Plan being tested: close at the target, the stop, or after ${plan.horizonMinutes} minutes, whichever comes first. Unproven: not yet tested on past data.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp),
                    )
                }
                Spacer(Modifier.height(10.dp))
            }
            Text(
                when (row.tier) {
                    Tier.CONFIRMED -> "Confirmed: the candle closed with an unusual move and every gate passed"
                    Tier.WATCH -> "Watch: unusual move in a candle that has not closed yet"
                    Tier.REJECTED -> "Rejected: unusual move, but a gate failed"
                    Tier.NONE -> "No unusual move right now"
                },
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(6.dp))
            Text(row.reason, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            Text("Main risk: ${row.mainRisk}", style = MaterialTheme.typography.bodyMedium, color = Palette.Amber)
            row.invalidation?.let { inv ->
                val dist = row.price?.let { p -> inv / p - 1 }
                Spacer(Modifier.height(6.dp))
                Text(
                    "Invalidation: ${Fmt.price(inv)} (${Fmt.pct(dist)} from here). The move's thesis fails if price goes ${if (row.direction == Direction.DOWN) "back above" else "back below"} the signal candle's ${if (row.direction == Direction.DOWN) "high" else "low"}.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (row.tier != Tier.NONE && row.cross.exchangesWithData > 1) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Seen on ${row.cross.confirmations} of ${row.cross.exchangesWithData} exchanges" + if (row.cross.isolated) " (isolated move)" else "",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun Checks(row: ScreenerRow) {
    if (row.checks.isEmpty()) return
    SectionTitle("v0.3 score: ${row.score ?: "n/a"} / 100 (EXPERIMENTAL)")
    Text(
        "Share of the checks below that pass (n/a ones are left out); all weighted equally because no backtest has set weights yet. A confirmed move becomes a signal at the minimum score set in Settings.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    for (c in row.checks) {
        val (mark, color) = when (c.passed) {
            true -> "✓" to Palette.Up
            false -> "✗" to Palette.Down
            null -> "–" to MaterialTheme.colorScheme.onSurfaceVariant
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
            Text(mark, color = color, fontWeight = FontWeight.Bold, modifier = Modifier.width(22.dp))
            Column {
                Text(c.name, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                Text(if (c.passed == null) "n/a: ${c.detail}" else c.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    Text("Holdout win rate: not tested (n = 0).", style = MaterialTheme.typography.bodySmall, color = Palette.Amber, modifier = Modifier.padding(top = 4.dp))
}

@Composable
private fun PlanValue(label: String, value: Double, color: Color) {
    Column {
        Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(Fmt.price(value), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = color)
    }
}

@Composable
private fun Breakdown(rows: List<ScreenerRow>) {
    SectionTitle("By exchange")
    Row(Modifier.fillMaxWidth()) {
        for (h in listOf("Exchange", "Price", "Move", "xATR", "Vol x", "24h vol")) {
            Text(h, Modifier.weight(1f), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    for (r in rows) {
        val f = r.focus
        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
            Text(r.instrument.exchange.label, Modifier.weight(1f), fontSize = 12.sp)
            Text(Fmt.price(r.price), Modifier.weight(1f), fontSize = 12.sp)
            Text(Fmt.pct(f?.move), Modifier.weight(1f), fontSize = 12.sp, color = moveColor(f?.move))
            Text(Fmt.num(f?.zMove, 1), Modifier.weight(1f), fontSize = 12.sp)
            Text(Fmt.times(f?.relVolume), Modifier.weight(1f), fontSize = 12.sp)
            Text(Fmt.usd(r.ticker?.quoteVolume24h), Modifier.weight(1f), fontSize = 12.sp)
        }
    }
}

@Composable
private fun Gates(row: ScreenerRow) {
    SectionTitle("Gates (all must pass for Confirmed)")
    for (g in row.gates) {
        val (mark, color) = when (g.passed) {
            true -> "✓" to Palette.Up
            false -> "✗" to Palette.Down
            null -> "?" to Palette.Amber
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
            Text(mark, color = color, fontWeight = FontWeight.Bold, modifier = Modifier.width(22.dp))
            Column {
                Text(g.name, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                Text(g.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun Features(row: ScreenerRow) {
    val f: FeatureSet? = row.focus
    SectionTitle("Feature values (${if (f?.closed == false) "candle in progress" else "last closed candle"})")
    KeyValue("Candle open", f?.let { Fmt.dateTime(it.candleOpenTime) } ?: Fmt.NA)
    KeyValue("Move (close vs previous close)", Fmt.pct(f?.move), moveColor(f?.move))
    KeyValue("Move in ATRs (volatility-normalized)", Fmt.num(f?.zMove, 2))
    KeyValue("ATR (20 candles), % of price", Fmt.pct(f?.atrPct, signed = false))
    KeyValue("Relative volume (vs median of up to 96 candles)", Fmt.times(f?.relVolume))
    KeyValue("BTC-adjusted move (residual)", Fmt.pct(f?.residual), moveColor(f?.residual))
    KeyValue("Beta to BTC", Fmt.num(f?.beta, 2))
    KeyValue(
        "Range breakout (20 candles)",
        when (f?.breakout) {
            Breakout.UP -> "above the high"
            Breakout.DOWN -> "below the low"
            Breakout.NONE -> "inside the range"
            null -> Fmt.NA
        },
    )
    KeyValue("Close location in candle", f?.closeLocation?.let { "${(it * 100).toInt()}% of range" } ?: Fmt.NA)
    KeyValue("Taker buy share", f?.takerImbalance?.let { "${((it + 1) / 2 * 100).toInt()}% buys" } ?: Fmt.NA)
    KeyValue("Trades in candle", f?.trades?.toString() ?: Fmt.NA)
    KeyValue("Trade count vs usual", Fmt.times(f?.tradeSpike))
    KeyValue("Data checks", f?.dataIssues?.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: if (f == null) Fmt.NA else "clean", if (f?.dataIssues?.isNotEmpty() == true) Palette.Down else Color.Unspecified)
}

@Composable
private fun Liquidity(row: ScreenerRow, tradeSize: Double, checking: Boolean, onCheck: () -> Unit) {
    SectionTitle("Order book (live only)")
    val d = row.depth
    if (d == null) {
        Text("Not checked in the last 3 minutes.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
        KeyValue("Checked at", Fmt.time(d.time))
        KeyValue("Spread", Fmt.pct(d.spread, digits = 3, signed = false))
        KeyValue("Bids / asks within 0.5%", "${Fmt.usd(d.bidUsdWithin05)} / ${Fmt.usd(d.askUsdWithin05)}")
        KeyValue("Bids / asks within 1%", "${Fmt.usd(d.bidUsdWithin1)} / ${Fmt.usd(d.askUsdWithin1)}")
        for (size in (listOf(1_000.0, 10_000.0, tradeSize)).distinct()) {
            val buy = d.buySlippage[size]
            val sell = d.sellSlippage[size]
            KeyValue(
                "Slippage ${Fmt.usd(size)} buy / sell",
                "${buy?.let { Fmt.pct(it, digits = 3, signed = false) } ?: "too thin"} / ${sell?.let { Fmt.pct(it, digits = 3, signed = false) } ?: "too thin"}",
            )
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
        OutlinedButton(onClick = onCheck, enabled = !checking) { Text("Check order book now") }
        if (checking) {
            Spacer(Modifier.width(10.dp))
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        }
    }
}
