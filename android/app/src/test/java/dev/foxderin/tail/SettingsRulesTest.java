package dev.foxderin.tail;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Objects;

/** Host-side regression entry point; needs only javac/java, not an Android runtime. */
public final class SettingsRulesTest {
    public static void main(String[] args) {
        cidrs(); context(); trials(); uids(); stateValues(); draftMerges();
    }
    private static void same(Object expected, Object actual) {
        if (!Objects.equals(expected, actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    private static void rejects(Runnable action) {
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Invalid input was accepted");
    }
    private static void cidrs() {
        same("192.168.1.0/24", SettingsRules.cidr("192.168.001.222/24"));
        same("0.0.0.0/0", SettingsRules.cidr("255.255.255.255/0"));
        same("255.255.255.255/32", SettingsRules.cidr("255.255.255.255/32"));
        same("2001:db8::/32", SettingsRules.cidr("2001:DB8:dead:beef:1234:5678:90ab:cdef/32"));
        same("::/0", SettingsRules.cidr("2001:db8::1/0"));
        same("::1/128", SettingsRules.cidr("::1/128"));
        same("::ffff:c000:200/120", SettingsRules.cidr("::ffff:192.0.2.128/120"));
        same("1::2:0:0:3:4/128", SettingsRules.cidr("1:0:0:2:0:0:3:4/128"));
        same("1:2:3:4:5:6:7:8/128", SettingsRules.cidr("1:2:3:4:5:6:7:8/128"));
        same(new LinkedHashSet<>(Arrays.asList("10.0.0.0/8", "2001:db8::/32")), SettingsRules.cidrs("10.1.2.3/8,10.2.3.4/8\n2001:db8::1/32"));
        for (String invalid : new String[]{"localhost/24", "1.2.3/24", "256.0.0.1/24", "1.2.3.4/-1", "1.2.3.4/33", "::1/129", "1:::2/64", "1::2::3/64", "1:2:3:4:5:6:7/128", "fe80::1%wlan0/64", "[::1]/128", "1:2:3:4:5:6:7:8::/128"}) rejects(() -> SettingsRules.cidr(invalid));
    }
    private static void context() {
        String original = "# 注释\r\nssid:Home:up\r\n\r\nunknown:future:action\r\nssid:Home:up\r\ncellular:-:down";
        same(Arrays.asList(1, 3, 4, 5), SettingsRules.visible(original));
        same(null, SettingsRules.parse("unknown:future:action"));
        same("ssid:Home:up", SettingsRules.parse(" \tssid:Home:up \t\r").line());
        same("ssid:Home:exit-node:fd7a:115c::2", SettingsRules.parse("ssid:Home:exit-node:fd7a:115c::2").line());
        same("# 注释\r\nssid:Office:down\r\n\r\nunknown:future:action\r\nssid:Home:up\r\ncellular:-:down", SettingsRules.replace(original, 1, "ssid:Office:down"));
        same(original, SettingsRules.move(SettingsRules.move(original, 1, 5), 1, 5));
        same("# 注释\r\nssid:Home:up\r\n\r\nunknown:future:action\r\nssid:Home:up\r\n", SettingsRules.remove(original, 5));
        same("# note\r\ncellular:-:up\r\n", SettingsRules.replace("# note", -1, "cellular:-:up").replace("\n", "\r\n"));
        same("# note\r\ncellular:-:up\r\nssid:Home:up\r\n", SettingsRules.replace("# note\r\ncellular:-:up", -1, "ssid:Home:up"));
        same("ssid:A:up", SettingsRules.replace("ssid:B:up", 0, "ssid:A:up"));
        same("", SettingsRules.remove("ssid:A:up", 0));
        same("", SettingsRules.remove("ssid:A:up\r\n", 0));
        for (String invalid : new String[]{"ssid::up", "ssid:unknown:up", "ssid:<none>:up", "ssid:\"Home\":up", "ssid:Home:up:extra", "ssid:Home:exit-node:", "ssid:Home#x:up", "cellular:Home:up", "cellular:-:up\u0000"}) same(null, SettingsRules.parse(invalid));
        rejects(() -> SettingsRules.replace(original, 1, "ssid::up"));
    }
    private static void trials() {
        for (String state : new String[]{"preparing", "running", "rolling-back", "rollback-failed"}) { same(true, SettingsRules.trialActive(state)); same(true, SettingsRules.trialState(state)); }
        for (String state : new String[]{"confirmed", "rolled-back", "superseded"}) { same(false, SettingsRules.trialActive(state)); same(true, SettingsRules.trialState(state)); }
        same(false, SettingsRules.trialState("")); same(false, SettingsRules.trialState("healthy"));
        same(30, SettingsRules.duration("30")); same(300, SettingsRules.duration("300")); same(91, SettingsRules.duration("91"));
        for (String value : new String[]{"29", "301", "-30", "0", "90.5", "999999999999"}) rejects(() -> SettingsRules.duration(value));
    }
    private static void uids() {
        same(new LinkedHashSet<>(Arrays.asList("0", "10001", "2147483647")), SettingsRules.uids("0,010001\n10001 2147483647"));
        same(new LinkedHashSet<>(), SettingsRules.uids(""));
        for (String value : new String[]{"-1", "1.5", "2147483648", "99999999999999999999999", "shell"}) rejects(() -> SettingsRules.uids(value));
    }
    private static void stateValues() {
        same("Yes", SettingsRules.booleanState(true, "Yes", "No", "Unknown"));
        same("No", SettingsRules.booleanState(false, "Yes", "No", "Unknown"));
        for (Object missing : new Object[]{null, "false", 0, new Object()}) same("Unknown", SettingsRules.booleanState(missing, "Yes", "No", "Unknown"));
        same("legacy", SettingsRules.textState("legacy", "Unknown"));
        same("local", SettingsRules.textState("local", "Unknown"));
        same("transparent", SettingsRules.textState("transparent", "Unknown"));
        for (Object missing : new Object[]{null, "", false, 0, new Object()}) same("Unknown", SettingsRules.textState(missing, "Unknown"));
    }
    private static void draft(String value, String baseline, boolean conflict, SettingsRules.Draft actual) {
        same(value, actual.value); same(baseline, actual.baseline); same(conflict, actual.conflict);
    }
    private static void draftMerges() {
        draft("disk", "disk", false, SettingsRules.mergeDraft(null, null, "disk", false));
        draft("restored", "restored", false, SettingsRules.mergeDraft("old", "old", "restored", false));
        draft("edited", "old", false, SettingsRules.mergeDraft("old", "edited", "old", false));
        SettingsRules.Draft conflict = SettingsRules.mergeDraft("old", "edited", "restored", false);
        draft("edited", "old", true, conflict);
        draft("edited", "old", true, SettingsRules.mergeDraft(conflict.baseline, conflict.value, "restored", false));
        draft("edited", "edited", false, SettingsRules.mergeDraft("old", "edited", "edited", false));
        draft("newer edit", "submitted", false, SettingsRules.mergeDraft("submitted", "newer edit", "submitted", false));
        draft("restored", "restored", false, SettingsRules.mergeDraft("submitted", "submitted", "restored", false));
        draft("old", "old", true, SettingsRules.mergeDraft("old", "old", "restored", true));
        draft("old", "old", false, SettingsRules.mergeDraft("old", "old", "old", true));
        draft("legacy draft", null, true, SettingsRules.mergeDraft(null, "legacy draft", "restored", false));
        draft("", "", false, SettingsRules.mergeDraft("old", "old", "", false));
    }
}
