package com.smartmoney.engine.replay

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipInputStream

/** Fetches raw bytes; null = the file does not exist (HTTP 404). Tests replace it. */
fun interface ByteFetcher {
    fun fetch(url: String): ByteArray?
}

class OkHttpFetcher(private val client: OkHttpClient) : ByteFetcher {
    override fun fetch(url: String): ByteArray? {
        var last: Exception? = null
        repeat(4) { attempt ->
            try {
                client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    if (r.code == 404 || r.code == 403 && url.contains("data.binance.vision")) return null
                    if (!r.isSuccessful) throw IOException("HTTP ${r.code} for $url")
                    return r.body?.bytes() ?: throw IOException("empty body for $url")
                }
            } catch (e: IOException) {
                last = e
                Thread.sleep(1_000L shl attempt)
            }
        }
        throw last ?: IOException("failed: $url")
    }
}

/**
 * Binance public archive (data.binance.vision) with a local cache. Every file is checked against Binance's own
 * `.CHECKSUM` (sha256) before use, and every file used is recorded for the dataset manifest.
 */
class Archive(
    private val cacheDir: File,
    private val fetcher: ByteFetcher,
    private val baseUrl: String = "https://data.binance.vision",
    private val listUrl: String = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision",
) {
    data class Entry(val path: String, val sha256: String, val bytes: Long, val source: String)

    private val used = ConcurrentHashMap<String, Entry>()

    /** Every file read in this run, sorted by path. */
    val manifest: List<Entry> get() = used.values.sortedBy { it.path }

    data class Listing(val folders: List<String>, val keys: List<String>)

    /** S3 listing under [prefix] (all pages). Folders are returned without the prefix and trailing slash. */
    fun list(prefix: String): Listing {
        val cached = File(cacheDir, "_listings/" + prefix.replace('/', '_') + ".txt")
        if (cached.exists()) {
            val lines = cached.readLines()
            return Listing(lines.filter { it.startsWith("D ") }.map { it.drop(2) }, lines.filter { it.startsWith("K ") }.map { it.drop(2) })
        }
        val folders = ArrayList<String>()
        val keys = ArrayList<String>()
        var marker: String? = null
        while (true) {
            val url = "$listUrl?delimiter=/&prefix=$prefix" + (marker?.let { "&marker=$it" } ?: "")
            val xml = fetcher.fetch(url)?.toString(Charsets.UTF_8) ?: throw IOException("listing failed: $url")
            Regex("<Prefix>([^<]*)</Prefix>").findAll(xml).map { it.groupValues[1] }.filter { it != prefix }
                .forEach { folders += it.removePrefix(prefix).trimEnd('/') }
            Regex("<Key>([^<]*)</Key>").findAll(xml).forEach { keys += it.groupValues[1] }
            val truncated = Regex("<IsTruncated>([^<]*)</IsTruncated>").find(xml)?.groupValues?.get(1) == "true"
            if (!truncated) break
            marker = Regex("<NextMarker>([^<]*)</NextMarker>").find(xml)?.groupValues?.get(1) ?: keys.lastOrNull() ?: break
        }
        cached.parentFile.mkdirs()
        cached.writeText((folders.map { "D $it" } + keys.map { "K $it" }).joinToString("\n"))
        return Listing(folders, keys)
    }

    /** Local copy of an archive file, verified against its .CHECKSUM; null if the archive has no such file. */
    fun get(path: String): File? {
        val f = File(cacheDir, path)
        val ok = File(cacheDir, "$path.sha256")
        val missing = File(cacheDir, "$path.missing")
        if (f.exists() && ok.exists()) {
            val h = sha256(f.readBytes())
            if (h == ok.readText().trim()) {
                used[path] = Entry(path, h, f.length(), "$baseUrl/$path")
                return f
            }
        }
        if (missing.exists()) return null
        repeat(2) {
            val bytes = fetcher.fetch("$baseUrl/$path")
            if (bytes == null) {
                missing.parentFile.mkdirs()
                missing.writeText("not in archive")
                return null
            }
            val expected = fetcher.fetch("$baseUrl/$path.CHECKSUM")?.toString(Charsets.UTF_8)?.trim()?.split(Regex("\\s+"))?.firstOrNull()
                ?: throw IOException("no CHECKSUM published for $path")
            val h = sha256(bytes)
            if (h.equals(expected, ignoreCase = true)) {
                f.parentFile.mkdirs()
                f.writeBytes(bytes)
                ok.writeText(h)
                used[path] = Entry(path, h, bytes.size.toLong(), "$baseUrl/$path")
                return f
            }
        }
        throw IOException("checksum mismatch for $path (downloaded twice)")
    }

    /** Records a non-archive input (e.g. the saved exchangeInfo) in the manifest. */
    fun record(path: String, file: File, source: String) {
        used[path] = Entry(path, sha256(file.readBytes()), file.length(), source)
    }

    companion object {
        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        /** Rows of the first CSV inside a zip; a header line (starting with a letter) is skipped. */
        fun forEachRow(zip: File, action: (List<String>) -> Unit) {
            ZipInputStream(zip.inputStream().buffered()).use { zis ->
                zis.nextEntry ?: return
                val reader = zis.bufferedReader()
                var first = true
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) continue
                    if (first) {
                        first = false
                        if (!line[0].isDigit() && line[0] != '-') continue
                    }
                    action(line.split(','))
                }
            }
        }
    }
}
