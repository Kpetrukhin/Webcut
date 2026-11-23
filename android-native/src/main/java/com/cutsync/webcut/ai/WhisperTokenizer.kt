package com.cutsync.webcut.ai

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.roundToLong

/**
 * Hugging Face Whisper `tokenizer.json` loader & GPT-2 ByteLevel BPE UTF-8 decoder.
 * Supports multilingual tokens (RU, EN, etc.) and timestamp tokens <|0.00|> .. <|30.00|>.
 */
class WhisperTokenizer private constructor(
    private val idToToken: Map<Int, String>,
    private val tokenToId: Map<String, Int>,
    val eotToken: Int,
    val sotToken: Int,
    val transcribeToken: Int,
    val translateToken: Int,
    val noSpeechToken: Int,
    val noTimestampsToken: Int,
    val startOfLmToken: Int,
    val startOfPrevToken: Int,
    val timestampBegin: Int,
    val timestampEnd: Int,
    val languageTokens: Map<String, Int>,
    val timestampMsByToken: Map<Int, Long>,
    private val specialTokenIds: Set<Int>
) {
    companion object {
        private val TIMESTAMP_REGEX = Regex("""^<\|(\d+(?:\.\d+)?)\|>$""")
        private val LANGUAGE_REGEX = Regex("""^<\|([a-z]{2,3})\|>$""")

        @Volatile
        private var cachedPath: String? = null

        @Volatile
        private var cachedMtime: Long = -1L

        @Volatile
        private var cachedInstance: WhisperTokenizer? = null

        // GPT-2 bytes_to_unicode() inverse table
        private val unicodeToByte: Map<Char, Byte> = buildMap {
            val bs = mutableListOf<Int>()
            for (b in 33..126) bs += b
            for (b in 161..172) bs += b
            for (b in 174..255) bs += b
            val cs = bs.toMutableList()
            var n = 0
            for (b in 0..255) {
                if (b !in bs) {
                    bs += b
                    cs += 256 + n
                    n++
                }
            }
            for (i in bs.indices) {
                put(cs[i].toChar(), bs[i].toByte())
            }
        }

        @Synchronized
        fun loadFromFile(tokenizerFile: File): WhisperTokenizer {
            val path = tokenizerFile.absolutePath
            val mtime = tokenizerFile.lastModified()
            val existing = cachedInstance
            if (existing != null && cachedPath == path && cachedMtime == mtime) {
                return existing
            }
            if (!tokenizerFile.exists() || !tokenizerFile.isFile) {
                throw IllegalStateException("Файл словаря tokenizer.json не найден в ai_models/")
            }

            val root = JSONObject(tokenizerFile.readText(Charsets.UTF_8))
            val idToToken = HashMap<Int, String>(60_000)
            val tokenToId = HashMap<String, Int>(60_000)
            val specialIds = HashSet<Int>(2048)

            val modelObj = root.optJSONObject("model")
            val vocabObj = modelObj?.optJSONObject("vocab")
            if (vocabObj != null) {
                val keys = vocabObj.keys()
                while (keys.hasNext()) {
                    val token = keys.next()
                    val id = vocabObj.optInt(token, -1)
                    if (id >= 0) {
                        idToToken[id] = token
                        tokenToId[token] = id
                    }
                }
            }

            val addedArr = root.optJSONArray("added_tokens")
            if (addedArr != null) {
                for (i in 0 until addedArr.length()) {
                    val item = addedArr.optJSONObject(i) ?: continue
                    val id = item.optInt("id", -1)
                    val content = item.optString("content", "")
                    if (id >= 0 && content.isNotEmpty()) {
                        idToToken[id] = content
                        tokenToId[content] = id
                        if (item.optBoolean("special", false) ||
                            (content.startsWith("<|") && content.endsWith("|>"))
                        ) {
                            specialIds += id
                        }
                    }
                }
            }

            val eot = tokenToId["<|endoftext|>"] ?: 50257
            val sot = tokenToId["<|startoftranscript|>"] ?: 50258
            val translate = tokenToId["<|translate|>"] ?: 50358
            val transcribe = tokenToId["<|transcribe|>"] ?: 50359
            val startOfLm = tokenToId["<|startoflm|>"] ?: 50360
            val startOfPrev = tokenToId["<|startofprev|>"] ?: 50361
            val noSpeech = tokenToId["<|nospeech|>"] ?: 50362
            val noTimestamps = tokenToId["<|notimestamps|>"] ?: 50363

            val languageTokens = LinkedHashMap<String, Int>()
            val timestampMsByToken = LinkedHashMap<Int, Long>()
            var minTsId = Int.MAX_VALUE
            var maxTsId = Int.MIN_VALUE

            for ((id, content) in idToToken) {
                if (content.startsWith("<|") && content.endsWith("|>")) {
                    specialIds += id
                    val tsMatch = TIMESTAMP_REGEX.matchEntire(content)
                    if (tsMatch != null) {
                        val sec = tsMatch.groupValues[1].toDoubleOrNull()
                        if (sec != null) {
                            timestampMsByToken[id] = (sec * 1000.0).roundToLong()
                            if (id < minTsId) minTsId = id
                            if (id > maxTsId) maxTsId = id
                        }
                    } else {
                        val langMatch = LANGUAGE_REGEX.matchEntire(content)
                        if (langMatch != null) {
                            languageTokens[langMatch.groupValues[1]] = id
                        }
                    }
                }
            }

            val tsBegin = if (minTsId != Int.MAX_VALUE) minTsId else (tokenToId["<|0.00|>"] ?: 50364)
            val tsEnd = if (maxTsId != Int.MIN_VALUE) maxTsId else (tokenToId["<|30.00|>"] ?: (tsBegin + 1500))

            return WhisperTokenizer(
                idToToken = idToToken,
                tokenToId = tokenToId,
                eotToken = eot,
                sotToken = sot,
                transcribeToken = transcribe,
                translateToken = translate,
                noSpeechToken = noSpeech,
                noTimestampsToken = noTimestamps,
                startOfLmToken = startOfLm,
                startOfPrevToken = startOfPrev,
                timestampBegin = tsBegin,
                timestampEnd = tsEnd,
                languageTokens = languageTokens,
                timestampMsByToken = timestampMsByToken,
                specialTokenIds = specialIds
            ).also {
                cachedPath = path
                cachedMtime = mtime
                cachedInstance = it
            }
        }
    }

    fun isTimestampToken(tokenId: Int): Boolean = tokenId >= timestampBegin && tokenId <= timestampEnd

    fun timestampMs(tokenId: Int): Long? = timestampMsByToken[tokenId]

    fun getLanguageTokenId(code: String): Int? = languageTokens[code.lowercase()]

    fun getControlTokenIdsToSuppress(): IntArray {
        val ids = mutableListOf(
            sotToken,
            translateToken,
            transcribeToken,
            startOfLmToken,
            startOfPrevToken,
            noSpeechToken,
            noTimestampsToken
        )
        ids.addAll(languageTokens.values)
        return ids.distinct().toIntArray()
    }

    fun decodeTokens(tokenIds: List<Int>): String {
        if (tokenIds.isEmpty()) return ""
        val bytes = ByteArrayOutputStream(tokenIds.size * 4)
        for (id in tokenIds) {
            if (id in specialTokenIds || isTimestampToken(id) || id == eotToken) {
                continue
            }
            val tokenStr = idToToken[id] ?: continue
            if (tokenStr.startsWith("<|") && tokenStr.endsWith("|>")) {
                continue
            }
            for (ch in tokenStr) {
                val b = unicodeToByte[ch]
                if (b != null) {
                    bytes.write(b.toInt() and 0xFF)
                } else {
                    val utf8 = ch.toString().toByteArray(Charsets.UTF_8)
                    bytes.write(utf8)
                }
            }
        }
        return String(bytes.toByteArray(), Charsets.UTF_8)
            .replace(Regex("\\s+"), " ")
            .trim()
    }
}
