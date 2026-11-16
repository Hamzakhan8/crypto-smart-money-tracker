package com.smartmoney.screener.ui.settings

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.screener.ENGINE_VERSION
import com.smartmoney.screener.container
import com.smartmoney.screener.data.AppSettings
import com.smartmoney.screener.service.ScanService
import com.smartmoney.screener.ui.DISCLAIMER
import com.smartmoney.screener.ui.Fmt
import com.smartmoney.screener.ui.Palette
import com.smartmoney.screener.ui.SectionTitle
import kotlinx.coroutines.launch
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    val c = context.container
    val settings by c.settings.settings.collectAsStateWithLifecycle(initialValue = null)
    val scope = rememberCoroutineScope()
    val s = settings ?: return
    fun update(t: (AppSettings) -> AppSettings) = scope.launch { c.settings.update(t) }

    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { /* the service runs either way */ }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("Settings", fontWeight = FontWeight.SemiBold) })
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            SectionTitle("Scanning")
            Caption("Exchanges")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (e in Exchange.entries) {
                    FilterChip(
                        selected = e in s.exchanges,
                        onClick = { update { st -> st.copy(exchanges = if (e in st.exchanges && st.exchanges.size > 1) st.exchanges - e else st.exchanges + e) } },
                        label = { Text(e.label) },
                    )
                }
            }
            Caption("Markets")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (m in Market.entries) {
                    FilterChip(
                        selected = m in s.markets,
                        onClick = { update { st -> st.copy(markets = if (m in st.markets && st.markets.size > 1) st.markets - m else st.markets + m) } },
                        label = { Text(m.label) },
                    )
                }
            }
            Caption("Candle timeframe")
            Chips(Timeframe.entries, s.timeframe, { it.label }) { tf -> update { it.copy(timeframe = tf) } }
            Caption("Most-traded coins followed per exchange and market (more = more data use)")
            Chips(listOf(20, 40, 80), s.universeSize, { it.toString() }) { n -> update { it.copy(universeSize = n) } }

            SectionTitle("Notifications")
            ToggleRow("Notify LONG signals", "Perps: a new LONG signal (entry, stop, target, score).", s.notifyLong) { on -> update { it.copy(notifyLong = on) }; if (on) ensureNotifications(context, s, notifyPermission::launch) }
            ToggleRow("Notify SHORT signals", "Perps: a new SHORT signal.", s.notifyShort) { on -> update { it.copy(notifyShort = on) }; if (on) ensureNotifications(context, s, notifyPermission::launch) }
            ToggleRow("Notify BUY signals", "Spot: a new BUY signal.", s.notifyBuy) { on -> update { it.copy(notifyBuy = on) }; if (on) ensureNotifications(context, s, notifyPermission::launch) }
            Caption("At most this many signal notifications per day (one per coin per hour)")
            Chips(listOf(5, 10, 20, 50), s.notifyDailyCap, { "$it" }) { v -> update { it.copy(notifyDailyCap = v) } }
            Caption("Quiet hours (no notifications, local time)")
            Chips(listOf("off", "22-7", "0-8"), s.quietHours, { if (it == "off") "Off" else it.replace("-", ":00 to ") + ":00" }) { v -> update { it.copy(quietHours = v) } }
            val allowed = context.container.notifier.canPost()
            Text(
                when {
                    !allowed -> "Notifications are blocked for this app. Allow them in Android settings (or switch a toggle above to be asked)."
                    !s.backgroundScan -> "Background scanning is off: you only get notifications while the app is open."
                    else -> "Notifications on. They also arrive while the app is closed (background scanning is on)."
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (!allowed || !s.backgroundScan) Palette.Amber else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 4.dp),
            )
            var testResult by remember { mutableStateOf<String?>(null) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { testResult = if (context.container.notifier.test()) "Sent: check your notifications" else "Blocked: allow notifications first" }) { Text("Send a test notification") }
                testResult?.let { Spacer(Modifier.width(10.dp)); Text(it, style = MaterialTheme.typography.bodySmall) }
            }

            SectionTitle("Signals (v0.3, EXPERIMENTAL)")
            Caption("Minimum score: share of the 8 checks that must pass (75 = at least 6 of 8). Higher = fewer signals.")
            Chips(listOf(50, 63, 75, 88, 100), s.minScore, { "$it" }) { v -> update { it.copy(minScore = v) } }

            SectionTitle("Unusual move")
            Caption("A candle counts as unusual when its move is at least this many ATRs (its usual range)")
            Chips(listOf(1.5, 2.0, 2.5, 3.0), s.moveThresholdZ, { "${it}x" }) { z -> update { it.copy(moveThresholdZ = z) } }

            SectionTitle("Gates (all must pass for Confirmed)")
            Caption("Minimum 24h volume")
            Chips(listOf(1e6, 5e6, 20e6, 50e6), s.minQuoteVolume24h, { Fmt.usd(it) }) { v -> update { it.copy(minQuoteVolume24h = v) } }
            Caption("Maximum spread")
            Chips(listOf(0.001, 0.002, 0.005), s.maxSpread, { Fmt.pct(it, signed = false, digits = 1) }) { v -> update { it.copy(maxSpread = v) } }
            Caption("Maximum slippage for your trade size")
            Chips(listOf(0.001, 0.003, 0.005), s.maxSlippage, { Fmt.pct(it, signed = false, digits = 1) }) { v -> update { it.copy(maxSlippage = v) } }
            Caption("Usual candle range must be at least this multiple of round-trip costs")
            Chips(listOf(1.0, 2.0, 3.0), s.costMultiple, { "${it.toInt()}x" }) { v -> update { it.copy(costMultiple = v) } }

            SectionTitle("You")
            Caption("Trade size (used for slippage and costs)")
            Chips(listOf(1_000.0, 10_000.0), s.tradeSizeUsd, { Fmt.usd(it) }) { v -> update { it.copy(tradeSizeUsd = v) } }
            NumberField("Custom trade size, USD", s.tradeSizeUsd, { String.format(Locale.US, "%.0f", it) }) { v ->
                if (v in 10.0..10_000_000.0) update { it.copy(tradeSizeUsd = v) }
            }
            ToggleRow(
                "Show SHORT signals on perps",
                "Perps: LONG after up moves and SHORT after down moves. Off: perps show LONG only. Spot always shows BUY only.",
                s.canShort,
            ) { on -> update { it.copy(canShort = on) } }

            SectionTitle("Taker fees (your fee tier)")
            Caption("Defaults are each exchange's base tier. Enter yours as a percent, e.g. 0.1.")
            for (e in Exchange.entries) for (m in Market.entries) {
                val key = AppSettings.feeKey(e, m)
                NumberField("${e.label} ${m.label} taker fee, %", (s.takerFees[key] ?: 0.0) * 100, { String.format(Locale.US, "%.3f", it) }) { v ->
                    if (v in 0.0..1.0) update { it.copy(takerFees = it.takerFees + (key to v / 100)) }
                }
            }

            SectionTitle("Background scanning")
            ToggleRow(
                "Keep scanning when the app is closed",
                "Logs history in the background with a quiet ongoing notification. Uses more battery and data. No alerts in this version.",
                s.backgroundScan,
            ) { on ->
                update { it.copy(backgroundScan = on) }
                if (on) {
                    if (Build.VERSION.SDK_INT >= 33 &&
                        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                    ) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    ScanService.start(context)
                } else {
                    ScanService.stop(context)
                }
            }
            BatteryRow(context)

            SectionTitle("About")
            Text("Engine $ENGINE_VERSION · settings hash ${s.toEngineConfig().hash}", style = MaterialTheme.typography.bodySmall)
            Text("Data: Binance, Bybit and OKX public market data. No account, no API key, no orders.", style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(6.dp))
            Text(DISCLAIMER, style = MaterialTheme.typography.bodySmall, color = Palette.Amber)
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Caption(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun <T> Chips(options: List<T>, selected: T, label: (T) -> String, onSelect: (T) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (o in options) FilterChip(selected = o == selected, onClick = { onSelect(o) }, label = { Text(label(o)) })
    }
}

@Composable
private fun ToggleRow(title: String, body: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** A number field that saves when the text is a valid number. */
@Composable
private fun NumberField(label: String, value: Double, format: (Double) -> String, onValid: (Double) -> Unit) {
    var text by remember { mutableStateOf(format(value)) }
    val parsed = text.replace(",", ".").toDoubleOrNull()
    // Follow outside changes (e.g. a size chip) without fighting the user's typing.
    LaunchedEffect(value) {
        val p = text.replace(",", ".").toDoubleOrNull()
        if (p == null || kotlin.math.abs(p - value) > 1e-9) text = format(value)
    }
    OutlinedTextField(
        value = text,
        onValueChange = {
            text = it
            it.replace(",", ".").toDoubleOrNull()?.let(onValid)
        },
        label = { Text(label) },
        isError = parsed == null,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    )
}

@Composable
private fun BatteryRow(context: Context) {
    var ignoring by remember { mutableStateOf(isIgnoringBattery(context)) }
    LaunchedEffect(Unit) { ignoring = isIgnoringBattery(context) }
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Battery optimization", style = MaterialTheme.typography.bodyLarge)
            Text(
                if (ignoring) "Not restricted: background scanning can keep running."
                else "Restricted: the phone may pause background scanning. Allow \"unrestricted\" for this app if you use background scanning.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(12.dp))
        OutlinedButton(onClick = {
            try {
                context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                context.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }) { Text("Open") }
    }
}

/** Turning a notification on: ask for the Android 13+ permission and make sure scanning runs in the background. */
private fun ensureNotifications(context: Context, s: AppSettings, ask: (String) -> Unit) {
    if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) ask(Manifest.permission.POST_NOTIFICATIONS)
    if (!s.backgroundScan) {
        kotlinx.coroutines.MainScope().launch { context.container.settings.update { it.copy(backgroundScan = true) } }
        ScanService.start(context)
    }
}

private fun isIgnoringBattery(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true
