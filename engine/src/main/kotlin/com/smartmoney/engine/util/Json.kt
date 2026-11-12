package com.smartmoney.engine.util

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Small, null-safe readers for exchange JSON. Numbers often arrive as strings; empty strings mean "missing". */
object J {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(text: String): JsonElement = json.parseToJsonElement(text)

    fun obj(e: JsonElement?): JsonObject? = e as? JsonObject
    fun arr(e: JsonElement?): JsonArray? = e as? JsonArray

    fun str(e: JsonElement?): String? {
        val p = e as? JsonPrimitive ?: return null
        if (p is JsonNull) return null
        val s = p.content
        return s.ifEmpty { null }
    }

    /** A finite number from a JSON number or numeric string; null if missing, empty or not a number. */
    fun num(e: JsonElement?): Double? {
        val v = str(e)?.toDoubleOrNull() ?: return null
        return if (v.isFinite()) v else null
    }

    fun long(e: JsonElement?): Long? {
        val s = str(e) ?: return null
        return s.toLongOrNull() ?: s.toDoubleOrNull()?.takeIf { it.isFinite() }?.toLong()
    }

    fun bool(e: JsonElement?): Boolean? {
        val p = e as? JsonPrimitive ?: return null
        if (p is JsonNull) return null
        return when (p.content.lowercase()) {
            "true", "1" -> true
            "false", "0" -> false
            else -> null
        }
    }
}

operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)
operator fun JsonElement?.get(index: Int): JsonElement? = (this as? JsonArray)?.getOrNull(index)
