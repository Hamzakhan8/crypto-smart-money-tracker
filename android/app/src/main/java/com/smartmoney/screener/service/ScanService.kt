package com.smartmoney.screener.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.smartmoney.engine.screener.EngineSnapshot
import com.smartmoney.engine.screener.FeedPhase
import com.smartmoney.engine.screener.SignalLabel
import com.smartmoney.engine.screener.Tier
import com.smartmoney.screener.MainActivity
import com.smartmoney.screener.R
import com.smartmoney.screener.container
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.launch

/**
 * Keeps scanning (and logging history) while the app is in the background. Shows one quiet, ongoing notification
 * with exchange status. Track A sends no alerts: nothing here is validated.
 */
class ScanService : LifecycleService() {

    @OptIn(FlowPreview::class)
    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, notification(this, "Starting the scanner"),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
        )
        container.controller.acquire(USER)
        lifecycleScope.launch {
            container.controller.snapshot.sample(15_000).collect { s ->
                try {
                    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(this@ScanService, summary(s)))
                } catch (e: SecurityException) {
                    // Notifications not allowed: scanning continues without updates to the notification.
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        return START_STICKY
    }

    override fun onDestroy() {
        container.controller.release(USER)
        super.onDestroy()
    }

    companion object {
        private const val USER = "service"
        private const val CHANNEL = "scan"
        private const val NOTIFICATION_ID = 7

        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, ScanService::class.java))
        fun stop(context: Context) = context.stopService(Intent(context, ScanService::class.java))

        private fun ensureChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL, "Background scanning", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Shown while the screener scans in the background"
                        setShowBadge(false)
                    },
                )
            }
        }

        private fun notification(context: Context, text: String): Notification {
            val open = PendingIntent.getActivity(
                context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            return NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_scan)
                .setContentTitle("Scanning (unproven screener)")
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setContentIntent(open)
                .build()
        }

        fun summary(s: EngineSnapshot): String {
            if (!s.running) return "Starting the scanner"
            val feeds = s.feeds.groupBy { it.id.exchange }.entries.joinToString("  ") { (ex, fs) ->
                val live = fs.count { it.phase == FeedPhase.LIVE }
                "${ex.label} ${if (live == fs.size) "live" else if (live > 0) "partly live" else fs.first().phase.label}"
            }
            val signals = s.rows.filter { it.tier == Tier.CONFIRMED && it.label != null }
            val counts = SignalLabel.entries.mapNotNull { l -> signals.count { it.label == l }.takeIf { it > 0 }?.let { "$it ${l.text}" } }
            return "$feeds\n${if (counts.isEmpty()) "No signals right now" else counts.joinToString(", ")} on ${s.config.timeframe.label} candles (unproven)"
        }
    }
}
