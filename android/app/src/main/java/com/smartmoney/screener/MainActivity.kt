package com.smartmoney.screener

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import com.smartmoney.screener.service.ScanService
import com.smartmoney.screener.ui.AppRoot
import com.smartmoney.screener.ui.SmartMoneyTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        setContent { SmartMoneyTheme { AppRoot() } }
        lifecycleScope.launch {
            val s = container.settings.settings.first()
            if (s.onboardingDone && s.backgroundScan) ScanService.start(this@MainActivity)
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
