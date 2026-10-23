package dev.foxderin.tail;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Objects;

/** Host-side regression entry point; needs only javac/java, not an Android runtime. */
public final class SettingsRulesTest {
    public static void main(String[] args) {
        cidrs(); trials(); uids();
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
    private static void trials() {
        same(30, SettingsRules.duration("30")); same(300, SettingsRules.duration("300")); same(91, SettingsRules.duration("91"));
        for (String value : new String[]{"29", "301", "-30", "0", "90.5", "999999999999"}) rejects(() -> SettingsRules.duration(value));
    }
    private static void uids() {
        same(new LinkedHashSet<>(Arrays.asList("0", "10001", "2147483647")), SettingsRules.uids("0,010001\n10001 2147483647"));
        same(new LinkedHashSet<>(), SettingsRules.uids(""));
        for (String value : new String[]{"-1", "1.5", "2147483648", "99999999999999999999999", "shell"}) rejects(() -> SettingsRules.uids(value));
    }
}
