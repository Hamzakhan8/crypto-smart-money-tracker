package com.smartmoney.engine.replay

import java.io.File
import java.io.IOException
import java.time.YearMonth
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** SYNTHETIC DATA (unit test only): archive checksums and caching, minute bars, universe as-of rules. */
class ArchiveAndUniverseTest {
    private fun zip(csv: String): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        ZipOutputStream(out).use { z -> z.putNextEntry(ZipEntry("x.csv")); z.write(csv.toByteArray()); z.closeEntry() }
        return out.toByteArray()
    }

    private class Fake(val files: Map<String, ByteArray>) : ByteFetcher {
        val calls = ArrayList<String>()
        override fun fetch(url: String): ByteArray? {
            calls += url
            return files[url]
        }
    }

    @Test
    fun verifiesChecksumsCachesAndRecords() {
        val body = zip("open_time,open\n1,2\n")
        val path = "data/futures/um/monthly/klines/X/1m/X-1m-2025-01.zip"
        val base = "https://data.binance.vision/$path"
        val fake = Fake(mapOf(base to body, "$base.CHECKSUM" to "${Archive.sha256(body)}  X-1m-2025-01.zip".toByteArray()))
        val dir = createTempDirectory("arch").toFile()
        val a = Archive(dir, fake)
        val f = a.get(path)!!
        assertTrue(f.readBytes().contentEquals(body))
        assertEquals(listOf(path), a.manifest.map { it.path })
        val calls = fake.calls.size
        Archive(dir, fake).get(path)
        assertEquals(calls, fake.calls.size, "second run reads the verified cache")
    }

    @Test
    fun rejectsAChecksumMismatchAndRemembersMissingFiles() {
        val body = zip("1,2\n")
        val base = "https://data.binance.vision/p/bad.zip"
        val fake = Fake(mapOf(base to body, "$base.CHECKSUM" to "00ff  bad.zip".toByteArray()))
        val dir = createTempDirectory("arch").toFile()
        assertFailsWith<IOException> { Archive(dir, fake).get("p/bad.zip") }
        assertFalse(File(dir, "p/bad.zip").exists(), "a file that fails the check is never kept")
        val a = Archive(dir, fake)
        assertNull(a.get("p/none.zip"))
        val n = fake.calls.size
        assertNull(a.get("p/none.zip"))
        assertEquals(n, fake.calls.size)
    }

    @Test
    fun listingFollowsPages() {
        val list = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=k/"
        val fake = Fake(
            mapOf(
                list to "<r><Prefix>k/</Prefix><CommonPrefixes><Prefix>k/AUSDT/</Prefix></CommonPrefixes><IsTruncated>true</IsTruncated><NextMarker>k/AUSDT/</NextMarker></r>".toByteArray(),
                "$list&marker=k/AUSDT/" to "<r><Prefix>k/</Prefix><CommonPrefixes><Prefix>k/BUSDT/</Prefix></CommonPrefixes><IsTruncated>false</IsTruncated></r>".toByteArray(),
            ),
        )
        assertEquals(listOf("AUSDT", "BUSDT"), Archive(createTempDirectory("arch").toFile(), fake).list("k/").folders)
    }

    @Test
    fun barsNeedAllFiveMinutesAndVolumeWindowsAreHalfOpen() {
        val t0 = 1_735_689_600_000L
        val rows = java.util.TreeMap<Long, DoubleArray>()
        for (i in 0 until 15) if (i != 7) rows[t0 + i * MINUTE] = doubleArrayOf(1.0, 2.0, 0.5, 1.5, 1.0, 10.0)
        val m = Minutes.fromRows("X", rows)
        val bars = m.bars5m()
        assertEquals(listOf(t0, t0 + 10 * MINUTE), bars.map { it.openTime }, "the bar with a missing minute is skipped")
        assertEquals(50.0, bars[0].quoteVolume)
        assertEquals(30.0, m.quoteVolume(t0, t0 + 3 * MINUTE))
        assertEquals(1_735_689_600_000L, archiveMillis(1_735_689_600_000_000L))
    }

    @Test
    fun universeUsesOnlyTheThirtyDaysBeforeTheMonth() {
        val lab = ReplayLab(Archive(createTempDirectory("arch").toFile(), Fake(emptyMap())), Fake(emptyMap()), createTempDirectory("c").toFile(), {})
        val jan = ReplayLab.start(YearMonth.of(2025, 1))
        fun days(from: Long, n: Int, vol: (Long) -> Double) = java.util.TreeMap<Long, Double>().apply { for (i in 0 until n) { val d = from + i * DAY; put(d, vol(d)) } }
        val daily = mapOf(
            "BTCUSDT" to days(jan - 30 * DAY, 30) { 1e6 },
            "BIGUSDT" to days(jan - 30 * DAY, 30) { 5e9 },
            "LATEUSDT" to days(jan, 60) { 9e12 }, // huge volume, but only from January on: not known on Jan 1
            "USDCUSDT" to days(jan - 30 * DAY, 30) { 9e11 }, // stablecoin
            "STOCKUSDT" to days(jan - 30 * DAY, 30) { 8e11 }, // TRADIFI_PERPETUAL
            "WEEKDAYUSDT" to days(jan - 30 * DAY, 30) { d ->
                val dow = java.time.Instant.ofEpochMilli(d).atZone(java.time.ZoneOffset.UTC).dayOfWeek.value
                if (dow >= 6) 1e9 else 7e11 // weekend volume collapses: a tokenized stock
            },
            "THINUSDT" to days(jan - 15 * DAY, 15) { 6e11 }, // fewer than 20 days
            // E005 change 3: a listed PERPETUAL with quiet weekends (like ETHUSDT in early 2026) stays in.
            "QUIETUSDT" to days(jan - 30 * DAY, 30) { d ->
                val dow = java.time.Instant.ofEpochMilli(d).atZone(java.time.ZoneOffset.UTC).dayOfWeek.value
                if (dow >= 6) 1e9 else 6e9
            },
        )
        val u = lab.universe(daily, mapOf("STOCKUSDT" to "TRADIFI_PERPETUAL", "QUIETUSDT" to "PERPETUAL")).getValue(YearMonth.of(2025, 1))
        // BIG 30 x $5B = $150B; QUIET 22 weekdays x $6B + 8 weekend days x $1B = $140B.
        assertEquals(listOf("BIGUSDT", "QUIETUSDT", "BTCUSDT"), u)
    }
}
