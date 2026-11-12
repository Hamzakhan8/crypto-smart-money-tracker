package com.smartmoney.screener

import android.app.Application
import android.content.Context
import com.smartmoney.engine.Engines
import com.smartmoney.screener.data.EngineController
import com.smartmoney.screener.data.HistoryDb
import com.smartmoney.screener.data.HistoryRecorder
import com.smartmoney.screener.data.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class ScreenerApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

/** The app's single instances: settings, history database, engine (one per process). */
class AppContainer(context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val settings = SettingsRepository(context)
    val db = HistoryDb.open(context)
    val recorder = HistoryRecorder(db.dao(), scope)
    val engine = Engines.create(scope, recorder)
    val controller = EngineController(engine, settings, recorder, scope)
}

val Context.container: AppContainer get() = (applicationContext as ScreenerApp).container
