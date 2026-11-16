package com.smartmoney.screener.data

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.smartmoney.engine.screener.GapRecord
import com.smartmoney.engine.screener.HitRecord
import kotlinx.coroutines.flow.Flow

/**
 * One closed candle with an unusual move, whether it passed the gates (Confirmed) or not (Rejected, with reasons).
 * Rejected ones are kept on purpose, so later analysis can test whether each gate helps.
 */
@Entity(tableName = "hits")
data class HitEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val candleOpenTime: Long,
    val loggedAt: Long,
    val exchange: String,
    val market: String,
    val canonical: String,
    val nativeSymbol: String,
    val timeframe: String,
    val tier: String,
    val label: String?,
    val direction: String?,
    val price: Double,
    val move: Double?,
    val zMove: Double?,
    val relVolume: Double?,
    val residual: Double?,
    val oiChange: Double?,
    val fundingRate: Double?,
    val invalidation: Double?,
    /** Plan target / stop (1 ATR) of a signal with an action; null for v0.1 rows and rows without an action. */
    val target: Double? = null,
    val stop: Double? = null,
    /** One failed gate per line. */
    val failedGates: String,
    /** One risk flag per line. */
    val flags: String,
    val confirmations: Int,
    val reason: String,
    val engineVersion: String,
    val configHash: String,
    /** v0.3 score (0-100) and whether the row was shown as a signal (v0.1/v0.2 rows: null / false). */
    val score: Int? = null,
    @ColumnInfo(defaultValue = "0") val isSignal: Boolean = false,
    /** Live paper result of a v0.3 signal: WIN, LOSS, TIMEOUT or UNTRACKED; net after estimated costs; exit price. */
    val paperStatus: String? = null,
    val paperNet: Double? = null,
    val paperExit: Double? = null,
) {
    companion object {
        fun from(h: HitRecord) = HitEntity(
            score = h.score, isSignal = h.isSignal,
            candleOpenTime = h.candleOpenTime, loggedAt = h.loggedAt, exchange = h.exchange.name, market = h.market.name,
            canonical = h.canonical, nativeSymbol = h.nativeSymbol, timeframe = h.timeframe.label, tier = h.tier.name,
            label = h.label?.text, direction = h.direction?.name, price = h.price, move = h.move, zMove = h.zMove,
            relVolume = h.relVolume, residual = h.residual, oiChange = h.oiChange, fundingRate = h.fundingRate,
            invalidation = h.invalidation, target = h.target, stop = h.stop,
            failedGates = h.failedGates.joinToString("\n"), flags = h.flags.joinToString("\n"),
            confirmations = h.confirmations, reason = h.reason, engineVersion = h.engineVersion, configHash = h.configHash,
        )
    }
}

/** A time when data was missing: an exchange was offline, or the app was not scanning. */
@Entity(tableName = "gaps")
data class GapEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val feed: String,
    val fromTime: Long,
    val toTime: Long,
    val reason: String,
) {
    companion object {
        fun from(g: GapRecord) = GapEntity(feed = g.feed.toString(), fromTime = g.from, toTime = g.to, reason = g.reason)
    }
}

@Dao
interface HistoryDao {
    @Insert
    suspend fun insertHit(hit: HitEntity)

    @Insert
    suspend fun insertGap(gap: GapEntity)

    @Query("SELECT * FROM hits ORDER BY candleOpenTime DESC, id DESC LIMIT :limit")
    fun hits(limit: Int): Flow<List<HitEntity>>

    /** Confirmed signals with an action (LONG, SHORT, BUY) since [since], newest first. */
    @Query("SELECT * FROM hits WHERE isSignal = 1 AND candleOpenTime >= :since ORDER BY candleOpenTime DESC, id DESC")
    fun signalsSince(since: Long): Flow<List<HitEntity>>

    /** v0.3 signals whose paper result is still open. */
    @Query("SELECT * FROM hits WHERE isSignal = 1 AND paperStatus IS NULL AND target IS NOT NULL AND stop IS NOT NULL AND candleOpenTime >= :since")
    suspend fun openPaper(since: Long): List<HitEntity>

    @Query("UPDATE hits SET paperStatus = :status, paperNet = :net, paperExit = :exit WHERE id = :id")
    suspend fun setPaper(id: Long, status: String, net: Double?, exit: Double?)

    /** Finished paper results of v0.3 signals since [since]. */
    @Query("SELECT * FROM hits WHERE isSignal = 1 AND paperStatus IN ('WIN', 'LOSS', 'TIMEOUT') AND candleOpenTime >= :since")
    fun paperResults(since: Long): Flow<List<HitEntity>>

    @Query("SELECT * FROM gaps ORDER BY toTime DESC LIMIT :limit")
    fun gaps(limit: Int): Flow<List<GapEntity>>

    @Query("DELETE FROM hits WHERE loggedAt < :before")
    suspend fun pruneHits(before: Long)

    @Query("DELETE FROM gaps WHERE toTime < :before")
    suspend fun pruneGaps(before: Long)

    @Query("DELETE FROM hits")
    suspend fun clearHits()

    @Query("DELETE FROM gaps")
    suspend fun clearGaps()
}

@Database(entities = [HitEntity::class, GapEntity::class], version = 3, exportSchema = false)
abstract class HistoryDb : RoomDatabase() {
    abstract fun dao(): HistoryDao

    companion object {
        /** v0.1 -> v0.2: adds the plan's target and stop. Existing history is kept. */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE hits ADD COLUMN target REAL")
                db.execSQL("ALTER TABLE hits ADD COLUMN stop REAL")
            }
        }

        /** v0.2 -> v0.3: score, signal flag and live paper result. Existing history is kept. */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE hits ADD COLUMN score INTEGER")
                db.execSQL("ALTER TABLE hits ADD COLUMN isSignal INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE hits ADD COLUMN paperStatus TEXT")
                db.execSQL("ALTER TABLE hits ADD COLUMN paperNet REAL")
                db.execSQL("ALTER TABLE hits ADD COLUMN paperExit REAL")
            }
        }

        fun open(context: Context): HistoryDb =
            Room.databaseBuilder(context, HistoryDb::class.java, "history.db").addMigrations(MIGRATION_1_2, MIGRATION_2_3).build()
    }
}
