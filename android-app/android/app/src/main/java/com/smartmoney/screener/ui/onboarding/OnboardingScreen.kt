package com.smartmoney.screener.ui.onboarding

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.smartmoney.screener.ui.Palette

@Composable
fun OnboardingScreen(onAccept: () -> Unit) {
    var understood by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
    ) {
        Text("Smart Money Screener", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text("Track A: plain screener", color = Palette.Amber)
        Spacer(Modifier.height(20.dp))
        Point("What it does", "Scans spot and perpetual markets on Binance, Bybit and OKX with public data (no account, no API key, it never places orders) and ranks coins by unusual moves: the move compared with the coin's usual candle range, its volume compared with normal, and its move after removing Bitcoin's part.")
        Point("What it does not do", "It does not predict. No signal type in this version has been validated, so every signal is labeled UNPROVEN and no score, probability or hit rate is shown. Most sudden moves fade.")
        Point("Not trading advice", "Signals are price moves, not advice to buy or sell. Crypto prices can fall to zero. Small coins can be pushed around. Decide for yourself, and never trade money you cannot lose.")
        Point("Your data", "Settings and the move history stay on this phone. The app only reads public market data from the three exchanges.")
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth().clickable { understood = !understood }, verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = understood, onCheckedChange = { understood = it })
            Text("I understand these are unproven price moves, not trading advice.")
        }
        Spacer(Modifier.height(16.dp))
        Button(onClick = onAccept, enabled = understood, modifier = Modifier.fillMaxWidth()) { Text("Continue") }
    }
}

@Composable
private fun Point(title: String, body: String) {
    Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
    Spacer(Modifier.height(4.dp))
    Text(body, style = MaterialTheme.typography.bodyMedium)
    Spacer(Modifier.height(14.dp))
}
