package dev.foxderin.tail;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Lossless context editing and numeric-only route input; never resolves hostnames. */
final class SettingsRules {
    private SettingsRules() {}
    private static final Pattern RULE = Pattern.compile("^(ssid|cellular):([^:]*):(up|down|exit-node|no-exit-node)(?::(.*))?$");
    static final class Rule {
        final String trigger, value, action, arg;
        Rule(String trigger, String value, String action, String arg) {
            this.trigger = trigger; this.value = value; this.action = action; this.arg = arg;
        }
        String line() { return trigger + ":" + (trigger.equals("cellular") ? "-" : value) + ":" + action + (action.equals("exit-node") ? ":" + arg : ""); }
    }
    static Rule parse(String line) {
        String text = line.replaceFirst("\\r$", "").replaceFirst("^[ \\t]+", "").replaceFirst("[ \\t]+$", "");
        if (Pattern.compile("[\\x00-\\x1f\\x7f#]").matcher(text).find()) return null;
        Matcher match = RULE.matcher(text);
        if (!match.matches()) return null;
        String trigger = match.group(1), value = match.group(2), action = match.group(3), arg = match.group(4);
        if (trigger.equals("cellular") ? !value.equals("-") : value.trim().isEmpty() || value.contains("\"") || Arrays.asList("unknown", "<unknown ssid>", "<none>").contains(value)) return null;
        if (action.equals("exit-node") ? arg == null || !arg.matches("[A-Za-z0-9:][A-Za-z0-9_.:%-]*") : arg != null) return null;
        return new Rule(trigger, value, action, arg == null ? "" : arg);
    }
    static List<Integer> visible(String raw) {
        String[] lines = raw.split("\n", -1);
        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < lines.length; i++) if (!lines[i].matches("[ \\t]*\\r?") && !lines[i].replaceFirst("\\r$", "").matches("[ \\t]*#.*")) out.add(i);
        return out;
    }
    static String replace(String raw, int index, String line) {
        if (parse(line) == null) throw new IllegalArgumentException("Invalid context rule");
        if (index < 0) {
            String newline = raw.contains("\r\n") ? "\r\n" : "\n";
            return raw + (!raw.isEmpty() && !raw.endsWith("\n") ? newline : "") + line + newline;
        }
        String[] lines = raw.split("\n", -1);
        lines[index] = line + (lines[index].endsWith("\r") ? "\r" : "");
        return String.join("\n", lines);
    }
    static String remove(String raw, int index) {
        Matcher matcher = Pattern.compile("[^\\n]*\\n|[^\\n]+$").matcher(raw);
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (matcher.find()) if (i++ != index) out.append(matcher.group());
        return out.toString();
    }
    static String move(String raw, int from, int to) {
        String[] lines = raw.split("\n", -1);
        String a = lines[from].replaceFirst("\\r$", ""), b = lines[to].replaceFirst("\\r$", "");
        lines[from] = b + (lines[from].endsWith("\r") ? "\r" : "");
        lines[to] = a + (lines[to].endsWith("\r") ? "\r" : "");
        return String.join("\n", lines);
    }
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
    static final class Draft {
        final String value, baseline;
        final boolean conflict;
        Draft(String value, String baseline, boolean conflict) {
            this.value = value; this.baseline = baseline; this.conflict = conflict;
        }
    }
    static Draft mergeDraft(String baseline, String draft, String saved, boolean editing) {
        boolean dirty = editing || draft != null && !draft.equals(baseline);
        if (!dirty || !editing && saved.equals(draft)) return new Draft(saved, saved, false);
        return new Draft(draft == null ? saved : draft, baseline, !saved.equals(baseline));
    }
    static String booleanState(Object value, String yes, String no, String unknown) {
        return value instanceof Boolean ? ((Boolean) value ? yes : no) : unknown;
    }
    static String textState(Object value, String unknown) {
        return value instanceof String && !((String) value).isEmpty() ? (String) value : unknown;
    }
    static boolean trialActive(String state) { return Arrays.asList("preparing", "running", "rolling-back", "rollback-failed").contains(state); }
    static boolean trialState(String state) { return trialActive(state) || Arrays.asList("confirmed", "rolled-back", "superseded").contains(state); }
    static int duration(String text) {
        if (!text.matches("[0-9]{2,3}")) throw new IllegalArgumentException("Duration must be 30–300 seconds");
        int value = Integer.parseInt(text);
        if (value < 30 || value > 300) throw new IllegalArgumentException("Duration must be 30–300 seconds");
        return value;
    }
}
