package com.smartmoney.screener.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
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
    /** One failed gate per line. */
    val failedGates: String,
    /** One risk flag per line. */
    val flags: String,
    val confirmations: Int,
    val reason: String,
    val engineVersion: String,
    val configHash: String,
) {
    companion object {
        fun from(h: HitRecord) = HitEntity(
            candleOpenTime = h.candleOpenTime, loggedAt = h.loggedAt, exchange = h.exchange.name, market = h.market.name,
            canonical = h.canonical, nativeSymbol = h.nativeSymbol, timeframe = h.timeframe.label, tier = h.tier.name,
            label = h.label?.text, direction = h.direction?.name, price = h.price, move = h.move, zMove = h.zMove,
            relVolume = h.relVolume, residual = h.residual, oiChange = h.oiChange, fundingRate = h.fundingRate,
            invalidation = h.invalidation, failedGates = h.failedGates.joinToString("\n"), flags = h.flags.joinToString("\n"),
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

@Database(entities = [HitEntity::class, GapEntity::class], version = 1, exportSchema = false)
abstract class HistoryDb : RoomDatabase() {
    abstract fun dao(): HistoryDao

    companion object {
        fun open(context: Context): HistoryDb = Room.databaseBuilder(context, HistoryDb::class.java, "history.db").build()
    }
}
