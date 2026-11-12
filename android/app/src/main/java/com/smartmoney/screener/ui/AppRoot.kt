package com.smartmoney.screener.ui

import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.InstrumentKey
import com.smartmoney.engine.model.Market
import com.smartmoney.screener.container
import com.smartmoney.screener.ui.detail.DetailScreen
import com.smartmoney.screener.ui.history.HistoryScreen
import com.smartmoney.screener.ui.onboarding.OnboardingScreen
import com.smartmoney.screener.ui.screener.ScreenerScreen
import com.smartmoney.screener.ui.settings.SettingsScreen
import kotlinx.coroutines.launch

private data class Tab(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val tabs = listOf(
    Tab("screener", "Screener", Icons.Default.Search),
    Tab("history", "History", Icons.AutoMirrored.Filled.List),
    Tab("settings", "Settings", Icons.Default.Settings),
)

@Composable
fun AppRoot() {
    val c = LocalContext.current.container
    val settings by c.settings.settings.collectAsStateWithLifecycle(initialValue = null)
    val scope = rememberCoroutineScope()
    val s = settings
    if (s == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    if (!s.onboardingDone) {
        OnboardingScreen(onAccept = { scope.launch { c.settings.update { it.copy(onboardingDone = true) } } })
        return
    }
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    Scaffold(
        contentWindowInsets = WindowInsets(0),
        bottomBar = {
            NavigationBar {
                for (t in tabs) {
                    NavigationBarItem(
                        selected = route == t.route || (t.route == "screener" && route?.startsWith("detail") == true),
                        onClick = {
                            nav.navigate(t.route) {
                                popUpTo("screener") { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(t.icon, contentDescription = null) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(nav, startDestination = "screener", modifier = Modifier.padding(padding)) {
            composable("screener") {
                ScreenerScreen(onOpen = { key -> nav.navigate(detailRoute(key)) })
            }
            composable(
                "detail/{market}/{canonical}?ex={ex}",
                arguments = listOf(
                    navArgument("market") { type = NavType.StringType },
                    navArgument("canonical") { type = NavType.StringType },
                    navArgument("ex") { type = NavType.StringType; defaultValue = Exchange.BINANCE.name },
                ),
            ) { e ->
                val market = Market.valueOf(e.arguments?.getString("market") ?: Market.SPOT.name)
                val canonical = e.arguments?.getString("canonical") ?: ""
                val ex = Exchange.valueOf(e.arguments?.getString("ex") ?: Exchange.BINANCE.name)
                DetailScreen(market, canonical, ex, onBack = { nav.popBackStack() })
            }
            composable("history") { HistoryScreen() }
            composable("settings") { SettingsScreen() }
        }
    }
}

private fun detailRoute(key: InstrumentKey) = "detail/${key.market.name}/${Uri.encode(key.canonical)}?ex=${key.exchange.name}"
