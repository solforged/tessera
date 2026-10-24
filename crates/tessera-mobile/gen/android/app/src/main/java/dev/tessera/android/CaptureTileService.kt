package dev.tessera.android

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

class CaptureTileService : TileService() {
  override fun onStartListening() {
    super.onStartListening()
    qsTile?.apply {
      state = Tile.STATE_INACTIVE
      updateTile()
    }
  }

  override fun onClick() {
    super.onClick()
    val intent = Intent(this, MainActivity::class.java)
      .setAction(MainActivity.ACTION_CAPTURE)
      .putExtra(MainActivity.EXTRA_CREATE_KIND, "note")
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startActivityAndCollapse(PendingIntent.getActivity(
        this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      ))
    } else {
      @Suppress("DEPRECATION")
      startActivityAndCollapse(intent)
    }
  }
}
