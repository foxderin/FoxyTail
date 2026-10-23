package dev.foxderin.tail;

import java.util.LinkedHashSet;
import java.util.Set;

/** Numeric-only route and trial input; never resolves hostnames. */
final class SettingsRules {
    private SettingsRules() {}
    static Set<String> uids(String raw) {
        Set<String> result = new LinkedHashSet<>();
        for (String value : raw.trim().split("[,\\s]+")) {
            if (value.isEmpty()) continue;
            if (!value.matches("[0-9]+")) throw new IllegalArgumentException("Invalid UID: " + value);
            long uid;
            try { uid = Long.parseLong(value); } catch (NumberFormatException e) { throw new IllegalArgumentException("Invalid UID: " + value); }
            if (uid > Integer.MAX_VALUE) throw new IllegalArgumentException("Invalid UID: " + value);
            result.add(Long.toString(uid));
        }
        return result;
    }
    static Set<String> cidrs(String raw) {
        Set<String> out = new LinkedHashSet<>();
        for (String value : raw.trim().split("[,\\s]+")) if (!value.isEmpty()) out.add(cidr(value));
        return out;
    }
    static String cidr(String input) {
        String[] parts = input.trim().split("/", -1);
        if (parts.length != 2 || !parts[1].matches("[0-9]{1,3}")) throw new IllegalArgumentException("Invalid CIDR: " + input);
        int prefix = Integer.parseInt(parts[1]);
        boolean v6 = parts[0].contains(":");
        int[] bytes = v6 ? ipv6(parts[0]) : ipv4(parts[0]);
        if (prefix > bytes.length * 8) throw new IllegalArgumentException("Invalid CIDR: " + input);
        for (int i = 0; i < bytes.length; i++) {
            int bits = Math.max(0, Math.min(8, prefix - i * 8));
            bytes[i] &= (0xff << (8 - bits)) & 0xff;
        }
        if (!v6) return bytes[0] + "." + bytes[1] + "." + bytes[2] + "." + bytes[3] + "/" + prefix;
        int[] words = new int[8];
        for (int i = 0; i < 8; i++) words[i] = bytes[2 * i] * 256 + bytes[2 * i + 1];
        int best = -1, count = 1;
        for (int i = 0; i < 8;) {
            if (words[i] != 0) { i++; continue; }
            int end = i;
            while (end < 8 && words[end] == 0) end++;
            if (end - i > count) { best = i; count = end - i; }
            i = end;
        }
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < 8;) {
            if (i == best) { out.append("::"); i += count; }
            else { if (out.length() > 0 && out.charAt(out.length() - 1) != ':') out.append(':'); out.append(Integer.toHexString(words[i++])); }
        }
        return out + "/" + prefix;
    }
    private static int[] ipv4(String raw) {
        String[] parts = raw.split("\\.", -1);
        if (parts.length != 4) throw new IllegalArgumentException("Invalid IPv4: " + raw);
        int[] bytes = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("[0-9]{1,3}")) throw new IllegalArgumentException("Invalid IPv4: " + raw);
            bytes[i] = Integer.parseInt(parts[i]);
            if (bytes[i] > 255) throw new IllegalArgumentException("Invalid IPv4: " + raw);
        }
        return bytes;
    }
    private static int[] ipv6(String raw) {
        if (!raw.matches("[0-9a-fA-F:.]+")) throw new IllegalArgumentException("Invalid IPv6: " + raw);
        if (raw.contains(".")) {
            int colon = raw.lastIndexOf(':');
            int[] v4 = ipv4(raw.substring(colon + 1));
            raw = raw.substring(0, colon + 1) + Integer.toHexString(v4[0] * 256 + v4[1]) + ":" + Integer.toHexString(v4[2] * 256 + v4[3]);
        }
        String[] halves = raw.split("::", -1);
        if (halves.length > 2) throw new IllegalArgumentException("Invalid IPv6: " + raw);
        String[] left = halves[0].isEmpty() ? new String[0] : halves[0].split(":", -1);
        String[] right = halves.length == 1 || halves[1].isEmpty() ? new String[0] : halves[1].split(":", -1);
        int size = left.length + right.length;
        if (halves.length == 1 ? size != 8 : size >= 8) throw new IllegalArgumentException("Invalid IPv6: " + raw);
        int[] bytes = new int[16];
        for (int i = 0; i < size; i++) {
            String word = i < left.length ? left[i] : right[i - left.length];
            if (!word.matches("[0-9a-fA-F]{1,4}")) throw new IllegalArgumentException("Invalid IPv6: " + raw);
            int at = i < left.length ? i : 8 - right.length + i - left.length;
            int value = Integer.parseInt(word, 16);
            bytes[2 * at] = value >> 8; bytes[2 * at + 1] = value & 255;
        }
        return bytes;
    }
    static int duration(String text) {
        if (!text.matches("[0-9]{2,3}")) throw new IllegalArgumentException("Duration must be 30–300 seconds");
        int value = Integer.parseInt(text);
        if (value < 30 || value > 300) throw new IllegalArgumentException("Duration must be 30–300 seconds");
        return value;
    }
}
