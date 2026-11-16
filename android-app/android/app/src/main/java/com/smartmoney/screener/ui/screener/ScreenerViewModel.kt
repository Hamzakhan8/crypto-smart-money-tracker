package com.smartmoney.screener.ui.screener

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.screener.FeedPhase
import com.smartmoney.engine.screener.FeedStatus
import com.smartmoney.engine.screener.ScreenerRow
import com.smartmoney.screener.AppContainer
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class ScreenerUi(
    val rows: List<ScreenerRow> = emptyList(),
    val spotCount: Int = 0,
    val perpCount: Int = 0,
    val feeds: List<FeedStatus> = emptyList(),
    val running: Boolean = false,
    val timeframe: Timeframe = Timeframe.M5,
    val filter: ScreenerFilter = ScreenerFilter(),
) {
    val allOffline: Boolean get() = feeds.isNotEmpty() && feeds.all { it.phase == FeedPhase.OFFLINE }
    val loading: Boolean get() = !running || (spotCount + perpCount == 0 && !allOffline)
}

class ScreenerViewModel(private val c: AppContainer) : ViewModel() {
    private val filter = MutableStateFlow(ScreenerFilter())

    /** The engine publishes once per second; sampling keeps the screen to at most one update per second. */
    @OptIn(FlowPreview::class)
    val ui: StateFlow<ScreenerUi> = combine(
        c.controller.snapshot.sample(1_000).onStart { emit(c.controller.snapshot.value) },
        filter,
        c.settings.settings,
    ) { s, f, settings ->
        ScreenerUi(
            rows = f.apply(s.rows),
            spotCount = s.rows.count { it.instrument.market == com.smartmoney.engine.model.Market.SPOT },
            perpCount = s.rows.count { it.instrument.market == com.smartmoney.engine.model.Market.PERP },
            feeds = s.feeds,
            running = s.running,
            timeframe = settings.timeframe,
            filter = f,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ScreenerUi())

    fun setFilter(f: ScreenerFilter) {
        filter.value = f
    }

    fun setTimeframe(tf: Timeframe) {
        viewModelScope.launch { c.settings.update { it.copy(timeframe = tf) } }
    }
}
