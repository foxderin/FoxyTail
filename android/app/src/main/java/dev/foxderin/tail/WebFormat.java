package dev.foxderin.tail;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/** bb7af04 format.ts: binary units and stable decimal/time conventions. */
final class WebFormat {
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm", Locale.ROOT);
    private WebFormat() { }
    static String bytes(long value) {
        if (value < 1024) return value + " B";
        if (value < 1048576) return String.format(Locale.ROOT, "%.1f KiB", value / 1024d);
        if (value < 1073741824) return String.format(Locale.ROOT, "%.1f MiB", value / 1048576d);
        return String.format(Locale.ROOT, "%.2f GiB", value / 1073741824d);
    }
    static String uptime(long seconds) {
        if (seconds < 60) return seconds + "s";
        if (seconds < 3600) return seconds / 60 + "m";
        if (seconds < 86400) return seconds / 3600 + "h " + seconds % 3600 / 60 + "m";
        return seconds / 86400 + "d " + seconds % 86400 / 3600 + "h";
    }
    static String time(long seconds) {
        return seconds == 0 ? "-" : TIME.format(Instant.ofEpochSecond(seconds).atZone(ZoneId.systemDefault()));
    }
}
