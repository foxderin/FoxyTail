package dev.foxderin.tail;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;

final class IncomingNotificationChecks {
    static void run(Context context) throws Exception {
        ActivityInfo receiver = context.getPackageManager().getReceiverInfo(new ComponentName(context, ReceiveNotificationReceiver.class), 0);
        if (!receiver.exported || !"android.permission.DUMP".equals(receiver.permission))
            throw new AssertionError("Incoming completion receiver must require privileged sender permission");
        if (receiver.directBootAware) throw new AssertionError("Shared storage completion does not run before unlock");
        Intent destination = ReceiveNotificationReceiver.inboxIntent(context);
        if (!new ComponentName(context, ControlActivity.class).equals(destination.getComponent()) ||
                !"files".equals(destination.getStringExtra(ControlActivity.DESTINATION)) ||
                !destination.getBooleanExtra("inbox", false) || destination.hasExtra("history") || destination.getData() != null ||
                (destination.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) != 0)
            throw new AssertionError("Incoming notification only opens fixed inbox, never supplied files or outgoing history");
        if (!"dev.foxderin.tail.RECEIVED".equals(ReceiveNotificationReceiver.ACTION))
            throw new AssertionError("Root notification action contract changed");
    }
}
