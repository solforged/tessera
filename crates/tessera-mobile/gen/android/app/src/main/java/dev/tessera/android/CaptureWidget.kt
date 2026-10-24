package dev.tessera.android

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

class CaptureWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, widgetIds: IntArray) {
    val views = RemoteViews(context.packageName, R.layout.capture_widget)
    bind(context, views, R.id.capture_note, 0, "note")
    bind(context, views, R.id.capture_task, 1, "task")
    bind(context, views, R.id.capture_question, 2, "question")
    manager.updateAppWidget(widgetIds, views)
  }

  private fun bind(context: Context, views: RemoteViews, viewId: Int, requestCode: Int, kind: String) {
    val intent = Intent(context, MainActivity::class.java)
      .setAction(MainActivity.ACTION_CAPTURE)
      .putExtra(MainActivity.EXTRA_CREATE_KIND, kind)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    // Extras do not distinguish PendingIntents; each kind needs its own request code.
    val pending = PendingIntent.getActivity(
      context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    views.setOnClickPendingIntent(viewId, pending)
  }
}
