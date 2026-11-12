package com.smartmoney.engine.replay

import com.smartmoney.engine.exchange.Symbols
import com.smartmoney.engine.features.Features
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.util.J
import com.smartmoney.engine.util.get
import java.io.File
import java.time.DayOfWeek
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneOffset
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.abs

/** Labels of one (symbol, time): every delay x both trade directions (slot = delay * 2 + dirIndex). */
class KeyResult(val width: Double, val beta: Double?) {
    val status = arrayOfNulls<Status>(8)
    val gross = DoubleArray(8) { Double.NaN }
    val hedged = DoubleArray(8) { Double.NaN }
    val cost1k = DoubleArray(8) { Double.NaN }
    val cost10k = DoubleArray(8) { Double.NaN }
    val mfe = DoubleArray(8) { Double.NaN }
    val mae = DoubleArray(8) { Double.NaN }
    val toPeak = IntArray(8) { -1 }
    val ambiguous = BooleanArray(8)

    companion object {
        fun slot(delay: Delay, dir: Int) = delay.ordinal * 2 + if (dir == 1) 0 else 1
    }
}

/** Signals and matched random times of one rule, real or placebo. */
class TradeSet(val name: String, val first: List<Sig>, val randoms: Map<Sig, LongArray>) {
    val events: List<Event> by lazy { Events.group(first) }
}

class Prepared(
    val universe: Map<YearMonth, List<String>>,
    val status: Map<String, String>,
    val costs: CostModel,
    val regime: Regime,
    val results: Map<String, KeyResult>,
    val real: Map<String, TradeSet>,
    val allSignals: Map<String, List<Sig>>,
    val shift: Map<String, TradeSet>,
    val symbolSwap: Map<String, TradeSet>,
    val minutesLoaded: Long,
    val barsBuilt: Long,
)

/**
 * The Replay Lab (Phase 3): downloads and verifies the Binance USD-M archive, builds the as-of universe, finds signals
 * of the pre-registered rules on 5m bars, draws matched random times and placebo signals, and labels them all with the
 * triple barrier, costs and BTC hedge. Every constant here is fixed in docs/experiments.md (shared definitions v1).
 */
class ReplayLab(
    private val archive: Archive,
    private val fetcher: ByteFetcher,
    private val cacheDir: File,
    private val log: (String) -> Unit,
    private val threads: Int = 12,
) {
    companion object {
        val WARMUP: YearMonth = YearMonth.of(2024, 12)
        val DEV_START: YearMonth = YearMonth.of(2025, 1)
        val DEV_END: YearMonth = YearMonth.of(2026, 6)
        val REGIME_FROM: YearMonth = YearMonth.of(2024, 1)
        const val TOP = 30
        const val N_RANDOM = 5
        const val SEED = 20261112L
        const val RULE_A = "A"
        const val RULE_C = "C"
        val RULES = listOf(RULE_A, RULE_C)
        const val A_MIN_MOVE = 0.02
        const val C_MIN_Z = 2.0
        const val C_MIN_VOL24 = 5_000_000.0
        const val C_MAX_SPREAD = 0.002
        const val C_MAX_SLIP = 0.003
        const val C_COST_MULT = 2.0
        const val BETA_BARS = 288
        const val BETA_MIN_PAIRS = 200
        const val UM = "data/futures/um"
        const val EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo"

        fun start(ym: YearMonth): Long = ym.atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        fun monthOf(t: Long): YearMonth = YearMonth.from(Instant.ofEpochMilli(t).atZone(ZoneOffset.UTC))
        fun months(from: YearMonth, to: YearMonth): List<YearMonth> = generateSequence(from) { it.plusMonths(1) }.takeWhile { it <= to }.toList()
        fun key(symbol: String, t: Long) = "$symbol@$t"
        val SIG_ORDER: Comparator<Sig> = compareBy({ it.t }, { it.symbol }, { it.moveDir }, { it.move })
        val devStartMs: Long get() = start(DEV_START)
        val devEndMs: Long get() = start(DEV_END.plusMonths(1))
    }

    private fun <T, R> parallel(items: List<T>, n: Int = threads, f: (T) -> R): List<R> {
        val pool = Executors.newFixedThreadPool(n)
        try {
            return items.map { pool.submit(Callable { f(it) }) }.map {
                try {
                    it.get()
                } catch (e: java.util.concurrent.ExecutionException) {
                    throw e.cause ?: e
                }
            }
        } finally {
            pool.shutdown()
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Data

    private class Info(val contractType: Map<String, String>, val status: Map<String, String>, val tick: Map<String, Double>)

    private fun exchangeInfo(): Info {
        val f = File(cacheDir, "exchangeInfo-um.json")
        if (!f.exists()) {
            val bytes = fetcher.fetch(EXCHANGE_INFO_URL) ?: error("exchangeInfo unavailable")
            f.parentFile.mkdirs()
            f.writeBytes(bytes)
        }
        archive.record("fapi/v1/exchangeInfo (saved ${Instant.ofEpochMilli(f.lastModified())})", f, EXCHANGE_INFO_URL)
        val j = J.parse(f.readText())
        val type = HashMap<String, String>()
        val status = HashMap<String, String>()
        val tick = HashMap<String, Double>()
        for (s in J.arr(j["symbols"]).orEmpty()) {
            val sym = J.str(s["symbol"]) ?: continue
            J.str(s["contractType"])?.let { type[sym] = it }
            J.str(s["status"])?.let { status[sym] = it }
            J.arr(s["filters"]).orEmpty().firstOrNull { J.str(it["filterType"]) == "PRICE_FILTER" }?.let { pf -> J.num(pf["tickSize"])?.let { tick[sym] = it } }
        }
        return Info(type, status, tick)
    }

    private fun daily(symbols: List<String>): Map<String, java.util.TreeMap<Long, Double>> {
        val wanted = months(WARMUP, DEV_END.minusMonths(1))
        val out = ConcurrentHashMap<String, java.util.TreeMap<Long, Double>>()
        parallel(symbols) { sym ->
            val keys = archive.list("$UM/monthly/klines/$sym/1d/").keys.toSet()
            val days = java.util.TreeMap<Long, Double>()
            for (ym in wanted) {
                val path = "$UM/monthly/klines/$sym/1d/$sym-1d-$ym.zip"
                if (path !in keys) continue
                archive.get(path)?.let { f -> Archive.forEachRow(f) { r -> days[archiveMillis(r[0].toLong())] = r[7].toDouble() } }
            }
            if (days.isNotEmpty()) out[sym] = days
        }
        return out
    }

    /** U1: top 30 by quote volume in the 30 days before each month start, after exclusions; BTCUSDT always in. */
    fun universe(daily: Map<String, java.util.TreeMap<Long, Double>>, contractType: Map<String, String>): Map<YearMonth, List<String>> {
        val out = LinkedHashMap<YearMonth, List<String>>()
        for (ym in months(DEV_START, DEV_END)) {
            val to = start(ym)
            val from = to - 30 * DAY
            val ranked = daily.mapNotNull { (sym, days) ->
                val win = days.subMap(from, true, to, false)
                if (win.size < 20) return@mapNotNull null
                val (base, _) = Symbols.perpBase(sym.removeSuffix("USDT"))
                if (Symbols.excluded(base) || contractType[sym] == "TRADIFI_PERPETUAL") return@mapNotNull null
                val we = ArrayList<Double>()
                val wd = ArrayList<Double>()
                for ((d, v) in win) {
                    val dow = Instant.ofEpochMilli(d).atZone(ZoneOffset.UTC).dayOfWeek
                    if (dow == DayOfWeek.SATURDAY || dow == DayOfWeek.SUNDAY) we += v else wd += v
                }
                // E005 change 3: the weekend rule only for symbols Binance no longer lists (a PERPETUAL is crypto by its label).
                if (contractType[sym] == null && we.size >= 6 && wd.size >= 15 && CostModel.median(wd) > 0 &&
                    CostModel.median(we) / CostModel.median(wd) < 0.35
                ) return@mapNotNull null
                sym to win.values.sum()
            }.sortedByDescending { it.second }.map { it.first }
            val top = ranked.take(TOP).toMutableList()
            if ("BTCUSDT" !in top) top += "BTCUSDT"
            out[ym] = top
        }
        return out
    }

    private fun neededMonths(universe: Map<YearMonth, List<String>>): Map<String, java.util.SortedSet<YearMonth>> {
        val out = HashMap<String, java.util.SortedSet<YearMonth>>()
        for ((ym, syms) in universe) for (s in syms) {
            val set = out.getOrPut(s) { java.util.TreeSet() }
            set += ym.minusMonths(1).coerceAtLeast(WARMUP)
            set += ym
            if (ym < DEV_END) set += ym.plusMonths(1)
        }
        out.getOrPut("BTCUSDT") { java.util.TreeSet() }.addAll(months(WARMUP, DEV_END))
        return out
    }

    private fun klinePath(sym: String, interval: String, ym: YearMonth) = "$UM/monthly/klines/$sym/$interval/$sym-$interval-$ym.zip"

    // ------------------------------------------------------------------------------------------------------------
    // Run

    fun prepare(): Prepared {
        log("listing USD-M perpetuals in the archive")
        val symbols = archive.list("$UM/monthly/klines/").folders.filter { it.endsWith("USDT") && !it.contains('_') }.sorted()
        log("  ${symbols.size} USDT perpetual symbols (delisted included)")
        val info = exchangeInfo()
        log("downloading daily candles for the universe")
        val daily = daily(symbols)
        val universe = universe(daily, info.contractType)
        val needed = neededMonths(universe)
        log("  universe: ${needed.size} distinct symbols over ${universe.size} months")

        log("downloading 1m candles, funding and order-book depth")
        val oneMinute = ConcurrentHashMap<String, List<File>>()
        val funding = ConcurrentHashMap<String, List<FundingEvent>>()
        val depth = ConcurrentHashMap<String, List<DepthSample>>()
        parallel(needed.keys.sorted()) { sym ->
            val ms = needed.getValue(sym)
            oneMinute[sym] = ms.mapNotNull { archive.get(klinePath(sym, "1m", it)) }
            val fe = ArrayList<FundingEvent>()
            for (ym in ms) archive.get("$UM/monthly/fundingRate/$sym/$sym-fundingRate-$ym.zip")?.let { f ->
                Archive.forEachRow(f) { r -> fe += FundingEvent(archiveMillis(r[0].toLong()), r[2].toDouble()) }
            }
            funding[sym] = fe.sortedBy { it.time }
            val ds = ArrayList<DepthSample>()
            for (ym in ms) {
                val day = ym.atDay(15)
                archive.get("$UM/daily/bookDepth/$sym/$sym-bookDepth-$day.zip")?.let { f ->
                    CostModel.depthFromFile(f, day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())?.let { ds += it }
                }
            }
            depth[sym] = ds.sortedBy { it.dayStart }
        }
        val costs = CostModel(info.tick, depth, funding)

        log("BTC hourly candles for the regime")
        val hourFiles = months(REGIME_FROM, DEV_END).mapNotNull { archive.get(klinePath("BTCUSDT", "1h", it)) }
        val hours = Minutes.load("BTCUSDT-1h", hourFiles)
        val regime = Regime(hours.t, hours.c, start(REGIME_FROM) + 7 * DAY)

        val btc = Minutes.load("BTCUSDT", oneMinute.getValue("BTCUSDT"))
        val btcBars = btc.bars5m()
        val btcClose = btcBars.associate { it.openTime to it.close }

        val results = ConcurrentHashMap<String, KeyResult>()
        val signals = ConcurrentHashMap<String, MutableList<Sig>>().also { m -> RULES.forEach { m[it] = java.util.Collections.synchronizedList(ArrayList()) } }
        val first = ConcurrentHashMap<String, MutableList<Sig>>().also { m -> RULES.forEach { m[it] = java.util.Collections.synchronizedList(ArrayList()) } }
        val randoms = ConcurrentHashMap<String, ConcurrentHashMap<Sig, LongArray>>().also { m -> RULES.forEach { m[it] = ConcurrentHashMap() } }
        val shiftFirst = ConcurrentHashMap<String, MutableList<Sig>>().also { m -> RULES.forEach { m[it] = java.util.Collections.synchronizedList(ArrayList()) } }
        val shiftRandoms = ConcurrentHashMap<String, ConcurrentHashMap<Sig, LongArray>>().also { m -> RULES.forEach { m[it] = ConcurrentHashMap() } }
        val memberMonths = HashMap<String, MutableSet<YearMonth>>()
        val rankOf = HashMap<Pair<String, YearMonth>, Int>()
        for ((ym, syms) in universe) syms.forEachIndexed { i, s -> memberMonths.getOrPut(s) { HashSet() } += ym; rankOf[s to ym] = i + 1 }
        var minutesLoaded = 0L
        var barsBuilt = 0L

        log("pass 1: signals, matched randoms, time-shift placebos, labels (${needed.size} symbols)")
        parallel(needed.keys.sorted(), n = 4) { sym ->
            val m = if (sym == "BTCUSDT") btc else Minutes.load(sym, oneMinute.getValue(sym))
            val bars = if (sym == "BTCUSDT") btcBars else m.bars5m()
            synchronized(this) { minutesLoaded += m.size; barsBuilt += bars.size }
            val ctx = SymbolCtx(sym, m, bars, costs, btc, btcClose)
            val member = memberMonths[sym].orEmpty()
            val found = RULES.associateWith { ArrayList<Sig>() }
            for (i in 1 until bars.size) {
                val b = bars[i]
                if (b.openTime < devStartMs || b.openTime >= devEndMs) continue
                val ym = monthOf(b.openTime)
                if (ym !in member) continue
                val prev = bars[i - 1]
                if (prev.openTime != b.openTime - FIVE_MIN || prev.close <= 0) continue
                val move = b.close / prev.close - 1
                val dir = if (move > 0) 1 else if (move < 0) -1 else continue
                val t = b.openTime + FIVE_MIN
                val rank = rankOf[sym to ym] ?: TOP + 1
                if (abs(move) >= A_MIN_MOVE) found.getValue(RULE_A) += Sig(RULE_A, sym, t, dir, move, null, rank)
                val atr = Features.atrPct(bars, i) ?: continue
                if (atr > 0 && abs(move / atr) >= C_MIN_Z) {
                    val f = Features.compute(bars, i, Timeframe.M5, null) ?: continue
                    val z = f.zMove ?: continue
                    if (abs(z) >= C_MIN_Z && f.dataIssues.isEmpty() && f.history > Features.ATR_LEN && ctx.passesAppGates(t, b.close, dir, atr)) {
                        found.getValue(RULE_C) += Sig(RULE_C, sym, t, dir, move, z, rank)
                    }
                }
            }
            for (rule in RULES) {
                val all = found.getValue(rule)
                signals.getValue(rule).addAll(all)
                val firstSigs = Events.firstSignals(all)
                first.getValue(rule).addAll(firstSigs)
                val busy = all.map { it.t }.toLongArray().also { it.sort() }
                for (s in firstSigs) {
                    val rs = ctx.randomTimes(s.t, busy, java.util.Random(SEED xor s.t xor rule.hashCode().toLong() xor (sym.hashCode().toLong() shl 20)))
                    randoms.getValue(rule)[s] = rs
                    ctx.labelAll(results, longArrayOf(s.t) + rs)
                    // Time-shift placebo (P1): same symbol, same time of day, 1-14 days earlier or later, in the universe.
                    val rng = java.util.Random(SEED + 17 xor s.t xor rule.hashCode().toLong() xor (sym.hashCode().toLong() shl 20))
                    for (attempt in 0 until 20) {
                        val k = (1 + rng.nextInt(14)) * (if (rng.nextBoolean()) 1 else -1)
                        val t2 = s.t + k * DAY
                        if (t2 - FIVE_MIN < devStartMs || t2 > devEndMs || monthOf(t2 - FIVE_MIN) !in member || !ctx.hasBar(t2)) continue
                        val p = s.copy(t = t2)
                        val prs = ctx.randomTimes(t2, busy, java.util.Random(SEED + 31 xor t2 xor rule.hashCode().toLong()))
                        shiftFirst.getValue(rule) += p
                        shiftRandoms.getValue(rule)[p] = prs
                        ctx.labelAll(results, longArrayOf(t2) + prs)
                        break
                    }
                }
            }
            log("  $sym: ${found.getValue(RULE_A).size} A, ${found.getValue(RULE_C).size} C signals")
        }

        log("pass 2: random-symbol placebo")
        val swapFirst = RULES.associateWith { java.util.Collections.synchronizedList(ArrayList<Sig>()) }
        val swapRandoms = RULES.associateWith { ConcurrentHashMap<Sig, LongArray>() }
        val tasks = HashMap<String, MutableList<Pair<String, Sig>>>()
        for (rule in RULES) {
            for (s in first.getValue(rule).sortedWith(compareBy({ it.t }, { it.symbol }))) {
                val ym = monthOf(s.t - FIVE_MIN)
                val others = universe[ym].orEmpty().filter { it != s.symbol }
                if (others.isEmpty()) continue
                val rng = java.util.Random(SEED + 53 xor s.t xor s.symbol.hashCode().toLong() xor rule.hashCode().toLong())
                val target = others[rng.nextInt(others.size)]
                tasks.getOrPut(target) { ArrayList() } += rule to s.copy(symbol = target, rank = rankOf[target to ym] ?: TOP + 1)
            }
        }
        val allByRuleSymbol = RULES.associateWith { r -> signals.getValue(r).groupBy { it.symbol } }
        parallel(tasks.keys.sorted(), n = 4) { sym ->
            val m = if (sym == "BTCUSDT") btc else Minutes.load(sym, oneMinute.getValue(sym))
            val bars = if (sym == "BTCUSDT") btcBars else m.bars5m()
            val ctx = SymbolCtx(sym, m, bars, costs, btc, btcClose)
            for ((rule, p) in tasks.getValue(sym)) {
                if (!ctx.hasBar(p.t)) continue
                val busy = allByRuleSymbol.getValue(rule)[sym].orEmpty().map { it.t }.toLongArray().also { it.sort() }
                val rs = ctx.randomTimes(p.t, busy, java.util.Random(SEED + 71 xor p.t xor sym.hashCode().toLong()))
                swapFirst.getValue(rule) += p
                swapRandoms.getValue(rule)[p] = rs
                ctx.labelAll(results, longArrayOf(p.t) + rs)
            }
        }

        return Prepared(
            universe = universe,
            status = info.status,
            costs = costs,
            regime = regime,
            results = results,
            // Parallel passes add signals in any order: sort by time AND symbol so sums and the seeded shuffle placebo
            // are identical on every run (pre-registration S1/P1 promise reproducible results).
            real = RULES.associateWith { TradeSet("real", first.getValue(it).sortedWith(SIG_ORDER), randoms.getValue(it)) },
            allSignals = RULES.associateWith { signals.getValue(it).sortedWith(SIG_ORDER) },
            shift = RULES.associateWith { TradeSet("time shift", Events.firstSignals(shiftFirst.getValue(it)), shiftRandoms.getValue(it)) },
            symbolSwap = RULES.associateWith { TradeSet("random symbol", Events.firstSignals(swapFirst.getValue(it)), swapRandoms.getValue(it)) },
            minutesLoaded = minutesLoaded,
            barsBuilt = barsBuilt,
        )
    }

    /** Everything that needs one symbol's data loaded. */
    private class SymbolCtx(
        val sym: String,
        val m: Minutes,
        val bars: List<Candle>,
        val costs: CostModel,
        val btc: Minutes,
        val btcClose: Map<Long, Double>,
    ) {
        private val barIndex = HashMap<Long, Int>(bars.size * 2).also { map -> bars.forEachIndexed { i, b -> map[b.openTime] = i } }

        /** True when the bar closing at [t] exists and has ATR history. */
        fun hasBar(t: Long): Boolean = barIndex[t - FIVE_MIN]?.let { it > Features.ATR_LEN } == true

        /** E002 rule C gates as far as history allows (24h volume, spread, $1,000 slippage, ATR vs round-trip cost). */
        fun passesAppGates(t: Long, price: Double, dir: Int, atrPct: Double): Boolean {
            if (m.quoteVolume(t - DAY, t) < C_MIN_VOL24) return false
            val spread = 2 * costs.halfSpread(sym, price)
            if (spread > C_MAX_SPREAD) return false
            val slip = costs.slippage(sym, 1_000.0, buy = dir == 1, signalTime = t) ?: return false
            if (slip > C_MAX_SLIP) return false
            return atrPct >= C_COST_MULT * (2 * costs.takerFee + spread + 2 * slip)
        }

        /** R1: up to 5 bar-close times on the same UTC day, at least 60 minutes from any signal of this symbol. */
        fun randomTimes(t: Long, busySorted: LongArray, rng: java.util.Random): LongArray {
            val day = t - Math.floorMod(t, DAY)
            val eligible = ArrayList<Long>()
            var c = day + FIVE_MIN
            while (c <= day + DAY) {
                if (c - FIVE_MIN >= devStartMs && c <= devEndMs && hasBar(c) && !near(busySorted, c)) eligible += c
                c += FIVE_MIN
            }
            eligible.shuffle(rng)
            return eligible.take(N_RANDOM).sorted().toLongArray()
        }

        private fun near(sorted: LongArray, t: Long): Boolean {
            var i = java.util.Arrays.binarySearch(sorted, t)
            if (i >= 0) return true
            i = -i - 1
            return (i < sorted.size && sorted[i] - t <= Events.SAME_EVENT_MS) || (i > 0 && t - sorted[i - 1] <= Events.SAME_EVENT_MS)
        }

        /** Beta of the coin's 5m returns on BTC's over the 288 bars before the signal bar (H1). */
        fun beta(i: Int): Double? {
            if (sym == "BTCUSDT") return 1.0
            val xs = ArrayList<Double>(BETA_BARS)
            val ys = ArrayList<Double>(BETA_BARS)
            for (j in maxOf(1, i - BETA_BARS) until i) {
                val a = bars[j]
                val p = bars[j - 1]
                if (p.openTime != a.openTime - FIVE_MIN || p.close <= 0) continue
                val b = btcClose[a.openTime] ?: continue
                val bp = btcClose[p.openTime] ?: continue
                ys += a.close / p.close - 1
                xs += b / bp - 1
            }
            if (xs.size < BETA_MIN_PAIRS) return null
            val mx = xs.average()
            val my = ys.average()
            var cov = 0.0
            var v = 0.0
            for (k in xs.indices) {
                cov += (xs[k] - mx) * (ys[k] - my)
                v += (xs[k] - mx) * (xs[k] - mx)
            }
            return if (v > 0) cov / v else null
        }

        fun labelAll(results: MutableMap<String, KeyResult>, times: LongArray) {
            for (t in times) {
                val k = key(sym, t)
                if (results.containsKey(k)) continue
                label(t)?.let { results[k] = it }
            }
        }

        private fun label(t: Long): KeyResult? {
            val i = barIndex[t - FIVE_MIN] ?: return null
            val atr = Features.atrPct(bars, i) ?: return null
            val width = atr * bars[i - 1].close
            val r = KeyResult(width, beta(i))
            for (delay in Delay.entries) for (dir in intArrayOf(1, -1)) {
                val s = KeyResult.slot(delay, dir)
                val o = Labeler.label(m, t, dir, width, delay)
                r.status[s] = o.status
                if (o.status == Status.INVALID) continue
                r.gross[s] = o.gross
                r.mfe[s] = o.mfe
                r.mae[s] = o.mae
                r.toPeak[s] = o.minutesToPeak
                r.ambiguous[s] = o.ambiguous
                r.cost1k[s] = costs.roundTrip(sym, dir, 1_000.0, t, o.entryPrice, o.exitPrice, o.entryTime, o.exitEnd)?.total ?: Double.NaN
                r.cost10k[s] = costs.roundTrip(sym, dir, 10_000.0, t, o.entryPrice, o.exitPrice, o.entryTime, o.exitEnd)?.total ?: Double.NaN
                val beta = r.beta
                if (beta != null) {
                    val bEntry = if (delay == Delay.D30) btc.idx(t).takeIf { it >= 0 && btc.v[it] > 0 }?.let { btc.qv[it] / btc.v[it] }
                    else btc.idx(o.entryTime).takeIf { it >= 0 }?.let { btc.o[it] }
                    val bExit = btc.idx(o.exitMinute).takeIf { it >= 0 }?.let { btc.c[it] }
                    if (bEntry != null && bExit != null && bEntry > 0) {
                        r.hedged[s] = dir * ((o.exitPrice / o.entryPrice - 1) - beta * (bExit / bEntry - 1))
                    }
                }
            }
            return r
        }
    }
}
