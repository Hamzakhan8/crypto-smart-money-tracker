package com.smartmoney.screener.data

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.smartmoney.engine.screener.HitRecord
import com.smartmoney.screener.MainActivity
import com.smartmoney.screener.R
import com.smartmoney.screener.ui.Fmt
import kotlinx.coroutines.flow.first
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/** Who gets notified: action switched on, outside quiet hours, under the daily cap, one per coin per hour. */
object AlertPolicy {
    const val COOLDOWN_MS = 60 * 60_000L

    enum class Decision { SEND, ACTION_OFF, QUIET_HOURS, DAILY_CAP, COOLDOWN }

    fun decide(action: String, s: AppSettings, localHour: Int, sentToday: Int, lastForCoin: Long?, now: Long): Decision = when {
        !enabled(action, s) -> Decision.ACTION_OFF
        inQuietHours(s.quietHours, localHour) -> Decision.QUIET_HOURS
        sentToday >= s.notifyDailyCap -> Decision.DAILY_CAP
        lastForCoin != null && now - lastForCoin < COOLDOWN_MS -> Decision.COOLDOWN
        else -> Decision.SEND
    }

    fun enabled(action: String, s: AppSettings) = when (action) {
        "LONG" -> s.notifyLong
        "SHORT" -> s.notifyShort
        "BUY" -> s.notifyBuy
        else -> false
    }

    fun anyEnabled(s: AppSettings) = s.notifyLong || s.notifyShort || s.notifyBuy

    /** "22-7" = from 22:00 to 06:59; "0-8" = from 00:00 to 07:59. */
    fun inQuietHours(quiet: String, hour: Int): Boolean {
        val parts = quiet.split("-").mapNotNull { it.toIntOrNull() }
        if (parts.size != 2) return false
        val (from, to) = parts
        return if (from <= to) hour in from until to else hour >= from || hour < to
    }
}

/**
 * Posts a heads-up notification for each new v0.3 signal the user switched on (LONG / SHORT / BUY), following
 * [AlertPolicy]. Signals that arrive together are grouped under one summary. Every notification says EXPERIMENTAL.
 */
class SignalNotifier(private val context: Context, private val settings: SettingsRepository) {
    private val prefs = context.getSharedPreferences("alerts", Context.MODE_PRIVATE)
    private val lastByCoin = HashMap<String, Long>()
    private val recent = ArrayDeque<String>()

    init {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Signals (LONG / SHORT / BUY)", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A new experimental signal: coin, direction, entry, stop, target and score"
                },
            )
        }
    }

    fun canPost(): Boolean = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    @Synchronized
    private fun sentToday(today: String): Int = if (prefs.getString("day", "") == today) prefs.getInt("count", 0) else 0

    @Synchronized
    private fun countOne(today: String) {
        val n = sentToday(today) + 1
        prefs.edit().putString("day", today).putInt("count", n).apply()
    }

    suspend fun onSignal(hit: HitRecord) {
        val action = hit.label?.text ?: return
        val s = settings.settings.first()
        val now = System.currentTimeMillis()
        val local = LocalDateTime.now(ZoneId.systemDefault())
        val today = LocalDate.now(ZoneId.systemDefault()).toString()
        val coin = "${hit.exchange}-${hit.market}-${hit.canonical}"
        val decision = synchronized(this) { AlertPolicy.decide(action, s, local.hour, sentToday(today), lastByCoin[coin], now) }
        if (decision != AlertPolicy.Decision.SEND || !canPost()) return
        synchronized(this) { lastByCoin[coin] = now }
        countOne(today)
        val title = "$action ${hit.canonical} · ${hit.exchange.label} ${hit.market.label.lowercase()}"
        val text = "Entry ${Fmt.price(hit.price)} · Stop ${Fmt.price(hit.stop)} · Target ${Fmt.price(hit.target)} · Score ${hit.score ?: "-"}"
        post(coin.hashCode() xor hit.candleOpenTime.hashCode(), title, text)
    }

    /** A sample notification so the user can check that notifications reach the phone. */
    fun test(): Boolean {
        if (!canPost()) return false
        post(TEST_ID, "TEST · LONG BTC/USDT · Binance perp", "This is how a signal notification looks. Entry, stop, target and score appear here.")
        return true
    }

    private fun post(id: Int, title: String, text: String) {
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val nm = context.getSystemService(NotificationManager::class.java)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_scan)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText("$text\nEXPERIMENTAL: not tested on past data. Not trading advice."))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setAutoCancel(true)
            .setGroup(GROUP)
            .setContentIntent(open)
            .build()
        try {
            nm.notify(id, n)
            synchronized(this) {
                recent.addFirst(title)
                while (recent.size > 5) recent.removeLast()
            }
            if (recent.size >= 2) {
                val inbox = NotificationCompat.InboxStyle().setSummaryText("Experimental signals")
                synchronized(this) { recent.forEach { inbox.addLine(it) } }
                nm.notify(
                    SUMMARY_ID,
                    NotificationCompat.Builder(context, CHANNEL)
                        .setSmallIcon(R.drawable.ic_stat_scan)
                        .setContentTitle("${recent.size} new signals")
                        .setStyle(inbox)
                        .setGroup(GROUP)
                        .setGroupSummary(true)
                        .setAutoCancel(true)
                        .setContentIntent(open)
                        .build(),
                )
            }
        } catch (e: SecurityException) {
            // Permission withdrawn: nothing is posted.
        }
    }

    companion object {
        const val CHANNEL = "signals"
        const val GROUP = "signals"
        const val SUMMARY_ID = 1_000
        const val TEST_ID = 1_001
    }
}
