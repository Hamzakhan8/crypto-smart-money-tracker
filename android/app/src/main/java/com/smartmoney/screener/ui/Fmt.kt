package com.smartmoney.screener.ui

import com.smartmoney.engine.screener.RowBuilder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

/** Display formatting. Null always shows as "n/a" (a missing metric is never shown as zero). */
object Fmt {
    const val NA = "n/a"

    fun price(p: Double?): String {
        if (p == null) return NA
        val a = abs(p)
        val pattern = when {
            a >= 1000 -> "%,.1f"
            a >= 100 -> "%.2f"
            a >= 1 -> "%.4f"
            a >= 0.01 -> "%.5f"
            else -> "%.8f"
        }
        return String.format(Locale.US, pattern, p)
    }

    fun pct(x: Double?, digits: Int = 2, signed: Boolean = true): String = x?.let { RowBuilder.pct(it, signed, digits) } ?: NA
    fun times(x: Double?): String = x?.let { String.format(Locale.US, "%.1fx", it) } ?: NA
    fun usd(x: Double?): String = x?.let { RowBuilder.usd(it) } ?: NA
    fun num(x: Double?, digits: Int = 2): String = x?.let { String.format(Locale.US, "%.${digits}f", it) } ?: NA
    fun ms(x: Long?): String = x?.let { "$it ms" } ?: NA

    fun time(t: Long): String = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(t))
    fun dateTime(t: Long): String = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(Date(t))

    fun duration(ms: Long): String {
        val m = ms / 60_000
        return when {
            m < 1 -> "${ms / 1000} s"
            m < 60 -> "$m min"
            m < 24 * 60 -> "${m / 60} h ${m % 60} min"
            else -> "${m / (24 * 60)} d ${(m / 60) % 24} h"
        }
    }
}
