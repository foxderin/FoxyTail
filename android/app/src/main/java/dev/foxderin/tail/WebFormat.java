package dev.foxderin.tail;

import java.util.Locale;

/** Binary units shared by native transfer notifications and export progress. */
final class WebFormat {
    private WebFormat() { }
    static String bytes(long value) {
        if (value < 1024) return value + " B";
        if (value < 1048576) return String.format(Locale.ROOT, "%.1f KiB", value / 1024d);
        if (value < 1073741824) return String.format(Locale.ROOT, "%.1f MiB", value / 1048576d);
        return String.format(Locale.ROOT, "%.2f GiB", value / 1073741824d);
    }
}
