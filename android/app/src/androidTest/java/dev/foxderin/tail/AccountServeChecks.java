package dev.foxderin.tail;

final class AccountServeChecks {
    static void run() {
        require(ServePage.sameDraft("443", "http://a", 0, 0, "443", "http://a", 0, 0), "Matching Serve draft recognized");
        require(!ServePage.sameDraft("443", "http://a", 0, 0, "443", "http://b", 0, 0), "Changed Serve target retained");
        require(!ServePage.sameDraft("443", "http://a", 0, 0, "8443", "http://a", 0, 0), "Changed Serve port retained");
        require(!ServePage.sameDraft("443", "http://a", 0, 0, "443", "http://a", 1, 0), "Changed Serve kind retained");
        require(!ServePage.sameDraft("443", "http://a", 0, 0, "443", "http://a", 0, 1), "Changed Serve protocol retained");
    }
    private static void require(boolean value, String detail) { if (!value) throw new AssertionError(detail); }
}
