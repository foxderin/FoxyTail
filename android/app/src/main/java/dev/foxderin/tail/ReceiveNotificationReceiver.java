package dev.foxderin.tail;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import org.json.JSONObject;
import java.io.IOException;

/** Explicit root completion hints. No file access, root execution or persistent service here.
 * The manifest's DUMP permission excludes ordinary apps, but also trusts privileged/adb-granted senders.
 */
public final class ReceiveNotificationReceiver extends BroadcastReceiver {
    static final String ACTION = "dev.foxderin.tail.RECEIVED";
    static final String CHANNEL = "taildrop-incoming";
    private static final int NOTIFICATION = 42;
    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("incoming-notifications", Context.MODE_PRIVATE);
    }
    static boolean allowed(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return manager.areNotificationsEnabled() && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE);
    }
    static JSONObject snapshot(Context context) {
        return WebBridge.object("ok", true, "enabled", preferences(context).getBoolean("enabled", false), "allowed", allowed(context));
    }
    static void setEnabled(Context context, boolean enabled) throws IOException {
        if (!preferences(context).edit().putBoolean("enabled", enabled).commit()) throw new IOException(context.getString(R.string.control_record_failed));
        if (enabled) createChannel(AppPreferences.localized(context));
        else context.getSystemService(NotificationManager.class).cancel(NOTIFICATION);
    }
    private static void createChannel(Context context) {
        context.getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL,
                context.getString(R.string.incoming_channel), NotificationManager.IMPORTANCE_DEFAULT));
    }
    static Intent inboxIntent(Context context) {
        return new Intent(context, ControlActivity.class).putExtra(ControlActivity.DESTINATION, "files").putExtra("inbox", true)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }
    @Override public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        String id = intent.getStringExtra("event_id");
        int count = intent.getIntExtra("count", 0);
        if (!IncomingNotificationReceipt.valid(id, count)) return;
        SharedPreferences prefs = preferences(context);
        if (!prefs.getBoolean("enabled", false) || !allowed(context)) {
            if (isOrderedBroadcast()) setResultCode(2); // Terminal suppression, not a reason to replay after opt-in.
            return;
        }
        String recent = prefs.getString("recent", "");
        if (IncomingNotificationReceipt.parse(recent).contains(id)) { if (isOrderedBroadcast()) setResultCode(1); return; }
        Context localized = AppPreferences.localized(context);
        createChannel(localized);
        PendingIntent open = PendingIntent.getActivity(context, NOTIFICATION, inboxIntent(context),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String message = localized.getResources().getQuantityString(R.plurals.incoming_completed, count, count);
        Notification notification = new Notification.Builder(localized, CHANNEL)
                .setSmallIcon(R.drawable.ic_tail).setContentTitle(localized.getString(R.string.incoming_title))
                .setContentText(message).setContentIntent(open).setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE).setCategory(Notification.CATEGORY_STATUS).build();
        // A notification is only a completion hint. It never authorizes opening any supplied path/URI.
        try { context.getSystemService(NotificationManager.class).notify(NOTIFICATION, notification); }
        catch (SecurityException denied) {
            if (isOrderedBroadcast()) setResultCode(2); // Permission may change after the availability check.
            return;
        }
        if (prefs.edit().putString("recent", IncomingNotificationReceipt.remember(recent, id)).commit() && isOrderedBroadcast()) setResultCode(1);
    }
}
