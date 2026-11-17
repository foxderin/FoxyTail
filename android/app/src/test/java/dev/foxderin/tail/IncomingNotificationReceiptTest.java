package dev.foxderin.tail;

/** Host-side regression for bounded replay suppression and untrusted event shape. */
public final class IncomingNotificationReceiptTest {
    public static void main(String[] args) {
        String id = String.format("%064x", 1);
        check(IncomingNotificationReceipt.valid(id, 1), "valid completion");
        for (String invalid : new String[]{null, "", "../file", "A".repeat(64), "f".repeat(63), "f".repeat(65)})
            check(!IncomingNotificationReceipt.valid(invalid, 1), "reject malformed event ID");
        for (int invalid : new int[]{-1, 0, 10001, Integer.MAX_VALUE})
            check(!IncomingNotificationReceipt.valid(id, invalid), "reject invalid completed count");
        check("completed".equals(IncomingNotificationReceipt.kind(null)), "legacy event defaults completed");
        check("pending".equals(IncomingNotificationReceipt.kind("pending")), "pending arrival accepted");
        check("completed".equals(IncomingNotificationReceipt.kind("completed")), "completed arrival accepted");
        for (String invalid : new String[]{"", "Pending", "received", "../pending"})
            check(IncomingNotificationReceipt.kind(invalid) == null, "unknown kind rejected");
        String ledger = "";
        for (int i = 0; i < 200; i++) ledger = IncomingNotificationReceipt.remember(ledger, String.format("%064x", i));
        check(IncomingNotificationReceipt.parse(ledger).size() == 128, "ledger bounded");
        check(!IncomingNotificationReceipt.parse(ledger).contains(id), "oldest receipts evicted");
        String latest = String.format("%064x", 199);
        check(IncomingNotificationReceipt.parse(ledger).contains(latest), "latest receipt retained");
        check(ledger.equals(IncomingNotificationReceipt.remember(ledger, latest)), "repeated delivery is idempotent");
        check(IncomingNotificationReceipt.parse("invalid\n" + latest).size() == 1, "only valid persisted receipts accepted");
        System.out.println("Incoming notification receipts passed");
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
