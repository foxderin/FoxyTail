package dev.foxderin.tail;

import java.util.LinkedHashSet;
import java.util.Set;

/** Small, ordered receipt ledger; the root monitor owns discovery, not the app. */
final class IncomingNotificationReceipt {
    static final int LIMIT = 128;
    static String kind(String value) {
        return value == null ? "completed" : ("pending".equals(value) || "completed".equals(value) ? value : null);
    }
    static boolean valid(String id, int count) {
        return id != null && id.matches("[a-f0-9]{64}") && count >= 1 && count <= 10000;
    }
    static Set<String> parse(String value) {
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        for (String id : value.split("\n")) if (valid(id, 1)) ids.add(id);
        return ids;
    }
    static String remember(String previous, String id) {
        Set<String> ids = parse(previous);
        ids.remove(id); ids.add(id);
        while (ids.size() > LIMIT) ids.remove(ids.iterator().next());
        return String.join("\n", ids);
    }
}
