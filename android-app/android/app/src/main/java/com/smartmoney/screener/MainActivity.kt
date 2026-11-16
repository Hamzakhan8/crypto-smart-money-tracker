package com.smartmoney.screener

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.smartmoney.screener.data.AlertPolicy
import com.smartmoney.screener.service.ScanService
import com.smartmoney.screener.ui.AppRoot
import com.smartmoney.screener.ui.SmartMoneyTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* answer stored by Android */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        setContent { SmartMoneyTheme { AppRoot() } }
        lifecycleScope.launch {
            var s = container.settings.settings.first()
            if (!s.onboardingDone) return@launch
            // v0.3.1: signal notifications need scanning while the app is closed; switch it on once.
            if (!s.notifySetupDone && AlertPolicy.anyEnabled(s)) {
                container.settings.update { it.copy(backgroundScan = true, notifySetupDone = true) }
                s = container.settings.settings.first()
            }
            if (AlertPolicy.anyEnabled(s) && Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (s.backgroundScan) ScanService.start(this@MainActivity)
        }
    }

    override fun onStart() {
        super.onStart()
        container.controller.acquire("ui")
    }

    override fun onStop() {
        container.controller.release("ui")
        super.onStop()
    }
}
