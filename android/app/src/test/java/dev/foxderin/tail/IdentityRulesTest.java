package dev.foxderin.tail;

/** Host-only metadata validation; never loads or creates a real identity state. */
public final class IdentityRulesTest {
    public static void main(String[] args) {
        if (!IdentityRules.filename("account.state") || !IdentityRules.filename("account.json") ||
                IdentityRules.filename("backup.tar.gz") || IdentityRules.filename("account.state.exe"))
            throw new AssertionError("Identity file type boundary");
        if (IdentityRules.MAX_IMPORT_BYTES != 4194304) throw new AssertionError("Identity size contract");
        IdentityRules.nickname("Travel phone");
        IdentityRules.nickname("设备");
        IdentityRules.nickname("🦊".repeat(128));
        rejects(""); rejects("x".repeat(129)); rejects("a\nb"); rejects("a\rb");
        rejects("a\u0000b"); rejects("a" + (char) 0x2028 + "b"); rejects("a" + (char) 0x2029 + "b");
    }
    private static void rejects(String value) {
        try { IdentityRules.nickname(value); }
        catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Invalid nickname accepted");
    }
}
