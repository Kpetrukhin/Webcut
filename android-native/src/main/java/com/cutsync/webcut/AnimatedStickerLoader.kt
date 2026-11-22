package com.cutsync.webcut

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Animatable
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import coil.ImageLoader
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import coil.disk.DiskCache
import coil.request.CachePolicy
import coil.request.ImageRequest
import coil.request.SuccessResult
import java.io.File

/**
 * Loads and caches animated WebP / GIF Giphy stickers on Android using Coil
 * and native AnimatedImageDrawable (API 28+) with GifDecoder fallback.
 */
object AnimatedStickerLoader {
    @Volatile
    private var cachedLoader: ImageLoader? = null

    fun getImageLoader(context: Context): ImageLoader {
        val existing = cachedLoader
        if (existing != null) return existing

        return synchronized(this) {
            cachedLoader ?: buildImageLoader(context.applicationContext).also {
                cachedLoader = it
            }
        }
    }

    private fun buildImageLoader(appContext: Context): ImageLoader {
        val mediaCacheDir = File(appContext.cacheDir, "cutsync_media/coil_stickers").apply {
            mkdirs()
        }
        return ImageLoader.Builder(appContext)
            .components {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    add(ImageDecoderDecoder.Factory())
                } else {
                    add(GifDecoder.Factory())
                }
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(mediaCacheDir)
                    .maxSizeBytes(128L * 1024 * 1024)
                    .build()
            }
            .diskCachePolicy(CachePolicy.ENABLED)
            .memoryCachePolicy(CachePolicy.ENABLED)
            .respectCacheHeaders(false)
            .build()
    }

    suspend fun loadStickerDrawable(
        context: Context,
        source: Any
    ): Drawable? {
        val loader = getImageLoader(context)
        val request = ImageRequest.Builder(context)
            .data(source)
            .allowHardware(false)
            .build()
        val result = loader.execute(request)
        if (result !is SuccessResult) return null
        val drawable = result.drawable
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && drawable is AnimatedImageDrawable) {
            drawable.repeatCount = AnimatedImageDrawable.REPEAT_INFINITE
            drawable.start()
        } else if (drawable is Animatable) {
            drawable.start()
        }
        return drawable
    }

    fun renderDrawableSnapshot(
        drawable: Drawable,
        widthPx: Int,
        heightPx: Int
    ): Bitmap {
        val w = widthPx.coerceAtLeast(1)
        val h = heightPx.coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        drawable.setBounds(0, 0, w, h)
        drawable.draw(canvas)
        return bmp
    }
}
