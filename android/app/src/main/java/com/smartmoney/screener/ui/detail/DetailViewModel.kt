package com.smartmoney.screener.ui.detail

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.InstrumentKey
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.screener.ScreenerRow
import com.smartmoney.screener.AppContainer
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class DetailUi(
    /** This coin on every exchange that has it, in this market. */
    val rows: List<ScreenerRow> = emptyList(),
    val selected: Exchange = Exchange.BINANCE,
    val canShort: Boolean = false,
    val tradeSize: Double = 1_000.0,
) {
    val row: ScreenerRow? get() = rows.firstOrNull { it.instrument.exchange == selected } ?: rows.firstOrNull()
}

class DetailViewModel(
    private val c: AppContainer,
    private val market: Market,
    private val canonical: String,
    initial: Exchange,
) : ViewModel() {
    private val selected = MutableStateFlow(initial)
    private val _candles = MutableStateFlow<List<Candle>>(emptyList())
    val candles: StateFlow<List<Candle>> = _candles.asStateFlow()
    private val _checking = MutableStateFlow(false)
    val checkingBook: StateFlow<Boolean> = _checking.asStateFlow()
    private val checked = HashSet<Exchange>()

    @OptIn(FlowPreview::class)
    val ui: StateFlow<DetailUi> = combine(
        c.controller.snapshot.sample(1_000).onStart { emit(c.controller.snapshot.value) },
        selected,
        c.settings.settings,
    ) { s, ex, settings ->
        DetailUi(
            rows = s.rows.filter { it.instrument.market == market && it.instrument.canonical == canonical }.sortedBy { it.instrument.exchange.ordinal },
            selected = ex,
            canShort = settings.canShort,
            tradeSize = settings.tradeSizeUsd,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), DetailUi(selected = initial))

    init {
        viewModelScope.launch {
            while (isActive) {
                _candles.value = c.controller.candles(InstrumentKey(selected.value, market, canonical)).takeLast(CHART_CANDLES)
                delay(2_000)
            }
        }
        viewModelScope.launch {
            selected.collect { ex -> if (checked.add(ex)) checkBook() }
        }
    }

    fun select(ex: Exchange) {
        selected.value = ex
        viewModelScope.launch { _candles.value = c.controller.candles(InstrumentKey(ex, market, canonical)).takeLast(CHART_CANDLES) }
    }

    /** Fetches the order book now (spread, depth, slippage for your trade size). */
    fun checkBook() {
        viewModelScope.launch {
            _checking.value = true
            try {
                c.controller.refreshDepth(InstrumentKey(selected.value, market, canonical))
            } finally {
                _checking.value = false
            }
        }
    }

    companion object {
        const val CHART_CANDLES = 72
    }
}
