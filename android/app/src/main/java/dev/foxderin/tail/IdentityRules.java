package dev.foxderin.tail;

/** Public request metadata only; credential contents are never parsed by the UI bridge. */
final class IdentityRules {
    static final long MAX_IMPORT_BYTES = 4 * 1024 * 1024;
    static boolean filename(String name) { return name.endsWith(".state") || name.endsWith(".json"); }
    static void nickname(String value) {
        if (value.isEmpty() || value.codePointCount(0, value.length()) > 128 ||
                value.codePoints().anyMatch(c -> Character.isISOControl(c) || c == 0x2028 || c == 0x2029))
            throw new IllegalArgumentException("Invalid account nickname");
    }
}
