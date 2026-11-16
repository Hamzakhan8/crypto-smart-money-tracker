package com.smartmoney.screener.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.smartmoney.engine.exchange.DefaultFees
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.screener.EngineConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/** Everything the user can set. Defaults follow docs/SPEC.md ($1,000 trade size; no shorting unless switched on). */
data class AppSettings(
    val onboardingDone: Boolean = false,
    val timeframe: Timeframe = Timeframe.M5,
    val exchanges: Set<Exchange> = Exchange.entries.toSet(),
    val markets: Set<Market> = Market.entries.toSet(),
    val universeSize: Int = 40,
    val minQuoteVolume24h: Double = 5_000_000.0,
    val maxSpread: Double = 0.002,
    val moveThresholdZ: Double = 2.0,
    val tradeSizeUsd: Double = 1_000.0,
    val maxSlippage: Double = 0.003,
    val costMultiple: Double = 2.0,
    /** Show SHORT signals on perps (spot is always BUY only). */
    val canShort: Boolean = true,
    /** v0.3: minimum score (share of checks passing) for a confirmed move to be shown as a signal. */
    val minScore: Int = 75,
    val backgroundScan: Boolean = false,
    /** Taker fee per "EXCHANGE_MARKET", fraction. */
    val takerFees: Map<String, Double> = defaultFees(),
    val lastAliveAt: Long? = null,
) {
    fun toEngineConfig() = EngineConfig(
        timeframe = timeframe, exchanges = exchanges, markets = markets, universeSize = universeSize,
        minQuoteVolume24h = minQuoteVolume24h, maxSpread = maxSpread, moveThresholdZ = moveThresholdZ,
        tradeSizeUsd = tradeSizeUsd, maxSlippage = maxSlippage, costMultiple = costMultiple, canShort = canShort,
        takerFees = takerFees, minScore = minScore,
    )

    companion object {
        fun feeKey(e: Exchange, m: Market) = "${e.name}_${m.name}"
        fun defaultFees(): Map<String, Double> =
            Exchange.entries.flatMap { e -> Market.entries.map { m -> feeKey(e, m) to DefaultFees.taker(e, m) } }.toMap()
    }
}

class SettingsRepository(private val context: Context) {
    private object K {
        val onboarding = booleanPreferencesKey("onboarding_done")
        val timeframe = stringPreferencesKey("timeframe")
        val exchanges = stringPreferencesKey("exchanges")
        val markets = stringPreferencesKey("markets")
        val universe = intPreferencesKey("universe")
        val minVol = doublePreferencesKey("min_volume")
        val maxSpread = doublePreferencesKey("max_spread")
        val z = doublePreferencesKey("move_z")
        val size = doublePreferencesKey("trade_size")
        val slip = doublePreferencesKey("max_slippage")
        val cost = doublePreferencesKey("cost_multiple")
        // v0.2: new key. v0.1 saved "can_short = false" by default, which would hide the perp SHORT signals.
        val short = booleanPreferencesKey("show_perp_shorts")
        val background = booleanPreferencesKey("background_scan")
        val minScore = intPreferencesKey("min_score")
        val alive = longPreferencesKey("last_alive")
        fun fee(key: String) = doublePreferencesKey("fee_$key")
    }

    val settings: Flow<AppSettings> = context.dataStore.data
        .catch { emit(emptyPreferences()) }
        .map { read(it) }

    suspend fun update(transform: (AppSettings) -> AppSettings) {
        context.dataStore.edit { p -> write(p, transform(read(p))) }
    }

    suspend fun setLastAlive(time: Long) {
        context.dataStore.edit { it[K.alive] = time }
    }

    private fun read(p: Preferences): AppSettings {
        val d = AppSettings()
        return AppSettings(
            onboardingDone = p[K.onboarding] ?: d.onboardingDone,
            timeframe = p[K.timeframe]?.let { Timeframe.fromLabel(it) } ?: d.timeframe,
            exchanges = p[K.exchanges]?.split(",")?.mapNotNull { n -> Exchange.entries.firstOrNull { it.name == n } }?.toSet() ?: d.exchanges,
            markets = p[K.markets]?.split(",")?.mapNotNull { n -> Market.entries.firstOrNull { it.name == n } }?.toSet() ?: d.markets,
            universeSize = p[K.universe] ?: d.universeSize,
            minQuoteVolume24h = p[K.minVol] ?: d.minQuoteVolume24h,
            maxSpread = p[K.maxSpread] ?: d.maxSpread,
            moveThresholdZ = p[K.z] ?: d.moveThresholdZ,
            tradeSizeUsd = p[K.size] ?: d.tradeSizeUsd,
            maxSlippage = p[K.slip] ?: d.maxSlippage,
            costMultiple = p[K.cost] ?: d.costMultiple,
            canShort = p[K.short] ?: d.canShort,
            backgroundScan = p[K.background] ?: d.backgroundScan,
            minScore = p[K.minScore] ?: d.minScore,
            takerFees = d.takerFees.mapValues { (k, v) -> p[K.fee(k)] ?: v },
            lastAliveAt = p[K.alive],
        )
    }

    private fun write(p: MutablePreferences, s: AppSettings) {
        p[K.onboarding] = s.onboardingDone
        p[K.timeframe] = s.timeframe.label
        p[K.exchanges] = s.exchanges.joinToString(",") { it.name }
        p[K.markets] = s.markets.joinToString(",") { it.name }
        p[K.universe] = s.universeSize
        p[K.minVol] = s.minQuoteVolume24h
        p[K.maxSpread] = s.maxSpread
        p[K.z] = s.moveThresholdZ
        p[K.size] = s.tradeSizeUsd
        p[K.slip] = s.maxSlippage
        p[K.cost] = s.costMultiple
        p[K.short] = s.canShort
        p[K.background] = s.backgroundScan
        p[K.minScore] = s.minScore
        for ((k, v) in s.takerFees) p[K.fee(k)] = v
    }
}
