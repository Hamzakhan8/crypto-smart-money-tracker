package com.smartmoney.screener

import com.smartmoney.screener.data.AlertPolicy
import com.smartmoney.screener.data.AlertPolicy.Decision
import com.smartmoney.screener.data.AppSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Notification rules: action switches, quiet hours, daily cap, per-coin cooldown. */
class AlertPolicyTest {
    private val s = AppSettings() // defaults: LONG and SHORT on, BUY off, cap 10, quiet hours off
    private val now = 1_794_000_000_000L

    @Test
    fun longAndShortOnByDefaultBuyOff() {
        assertEquals(Decision.SEND, AlertPolicy.decide("LONG", s, 12, 0, null, now))
        assertEquals(Decision.SEND, AlertPolicy.decide("SHORT", s, 12, 0, null, now))
        assertEquals(Decision.ACTION_OFF, AlertPolicy.decide("BUY", s, 12, 0, null, now))
        assertEquals(Decision.SEND, AlertPolicy.decide("BUY", s.copy(notifyBuy = true), 12, 0, null, now))
        assertEquals(Decision.ACTION_OFF, AlertPolicy.decide("SHORT", s.copy(notifyShort = false), 12, 0, null, now))
    }

    @Test
    fun quietHoursAcrossMidnight() {
        assertTrue(AlertPolicy.inQuietHours("22-7", 23))
        assertTrue(AlertPolicy.inQuietHours("22-7", 3))
        assertFalse(AlertPolicy.inQuietHours("22-7", 7))
        assertFalse(AlertPolicy.inQuietHours("22-7", 21))
        assertTrue(AlertPolicy.inQuietHours("0-8", 0))
        assertFalse(AlertPolicy.inQuietHours("0-8", 8))
        assertFalse(AlertPolicy.inQuietHours("off", 3))
        assertEquals(Decision.QUIET_HOURS, AlertPolicy.decide("LONG", s.copy(quietHours = "22-7"), 2, 0, null, now))
    }

    @Test
    fun dailyCapAndCoinCooldown() {
        assertEquals(Decision.DAILY_CAP, AlertPolicy.decide("LONG", s, 12, 10, null, now))
        assertEquals(Decision.SEND, AlertPolicy.decide("LONG", s, 12, 9, null, now))
        assertEquals(Decision.COOLDOWN, AlertPolicy.decide("LONG", s, 12, 0, now - 30 * 60_000L, now))
        assertEquals(Decision.SEND, AlertPolicy.decide("LONG", s, 12, 0, now - 61 * 60_000L, now))
    }
}
