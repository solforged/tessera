package dev.tessera.android

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Keeps the launcher's CLEAR_TASK in a throwaway task, never Tessera's task. */
class CaptureShortcutActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val kind = intent.getStringExtra(MainActivity.EXTRA_CREATE_KIND) ?: "note"
    val capture = Intent(this, MainActivity::class.java)
      .setAction(MainActivity.ACTION_CAPTURE)
      .putExtra(MainActivity.EXTRA_CREATE_KIND, kind)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    startActivity(capture)
    finish()
  }
}
