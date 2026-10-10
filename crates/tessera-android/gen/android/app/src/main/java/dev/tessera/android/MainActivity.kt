package dev.tessera.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : TauriActivity() {
  private var inboxWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    inboxWebView = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Drawn edge to edge, the window no longer shrinks for the keyboard, and the WebView ignores
    // `interactive-widget=resizes-content`. Lift the page above the keyboard; the WebView then
    // reports no bottom safe-area inset, since the navigation bar is behind the keyboard.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      view.setPadding(0, 0, 0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
      insets
    }
    if (savedInstanceState == null) receiveBook(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    receiveBook(intent)
  }

  private fun receiveBook(intent: Intent) {
    val uri = when (intent.action) {
      Intent.ACTION_VIEW -> intent.data
      Intent.ACTION_SEND -> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        } ?: intent.clipData?.getItemAt(0)?.uri
      }
      else -> null
    } ?: return
    // Copy while the sender's transient URI grant is held. Rust never opens content:// itself.
    inboxExecutor.execute {
      val inbox = File(cacheDir, "inbox")
      val id = UUID.randomUUID().toString()
      var partial: File? = null
      try {
        check(inbox.isDirectory || inbox.mkdirs()) { "Cannot create the import inbox" }
        var name = uri.lastPathSegment ?: "Book.epub"
        if (uri.scheme == "content") {
          contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0)
          }
        }
        name = name.replace('/', '_').replace('\\', '_')
        if (!name.endsWith(".epub", ignoreCase = true)) name += ".epub"
        val destination = File(inbox, "${id}_$name")
        val staging = File(inbox, "${id}.part")
        partial = staging
        contentResolver.openInputStream(uri)?.use { input ->
          staging.outputStream().use { output -> input.copyTo(output) }
        } ?: error("Cannot read $name")
        check(staging.renameTo(destination)) { "Cannot finish importing $name" }
      } catch (error: Exception) {
        partial?.delete()
        File(inbox, "${id}.error").writeText("Cannot open EPUB: ${error.message ?: error.javaClass.simpleName}")
      }
      runOnUiThread {
        inboxWebView?.evaluateJavascript(
          "window.dispatchEvent(new Event('tessera-opened-files-ready'))", null
        )
      }
    }
  }

  companion object {
    private val inboxExecutor = Executors.newSingleThreadExecutor()
  }
}
