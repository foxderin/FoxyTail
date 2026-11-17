# Reduced native regression scope

Baseline: `544e2ab`. Count actual `func TestX(*testing.T)` declarations, not
assertions, table rows, or `TestMain`. Baseline 153; retained 76; removed 77
(50.33%). Deleted scenarios are not moved into tables or another runner.
Production code is unchanged. This is a smaller risk-based suite, **not equal
coverage in fewer tests**. Source-line reduction is a separate metric.

## Retained priorities

- DNS resolver selection, malformed packets, injected checksums, exact flow
  identity, foreign marks, changed interfaces/routes, missing context, private
  trust boundaries, TLS identity, listener shutdown, and real UDP/TCP requests.
- Archive traversal/member validation and symlink rejection; artifact lease and
  stalled-copy cancellation; outgoing account/source validation and cancellation.
- All identity-state validation, restore fences, interrupted-publication recovery,
  absent-baseline recovery, and private artifact regressions.
- Incoming publish-before-delete, no-overwrite, retry after cleanup failure,
  incomplete/changed/oversized sources, account checks, and interrupted input.
- Statistics ordering, partial rows, cache invalidation and symlink boundary;
  active transfer ownership, orphan recovery, and history deletion boundaries.

## Deliberately reduced coverage

Duplicate happy-path/observability checks and secondary combinations are removed
first. Broader retained scenarios still exercise the relevant components, but do
not imply every deleted assertion remains covered. In particular:

- No dedicated native tests remain for some health counters, quiet health reads,
  helper flag precedence, socket/route IPv4 capability probes, or supplementary
  original-resolver/IPv6 selector examples.
- All four privileged network-namespace gate scenarios are retained. They may
  skip on an unprivileged host; only the required privileged gate establishes
  kernel integration results.
- DNS low-level ACK, datagram framing, individual timeout/capacity and retry
  variants are sampled rather than exhaustively exercised.
- Artifact quota/expiry variants, stage expiry, invalid-token/length matrices,
  inbox metadata races/UTF-8/size bounds and archive inclusive limits no longer
  each have a dedicated native test. Retained boundary tests are not substitutes
  for all of these cases.
- Statistics malformed-number permutations, stale temporary-file sweeping and
  oversized-input variants lose dedicated tests; transfer short-write, delayed
  lock acquisition, corrupt-owner stopping and stale-stage sweeping do too.
- Removed end-to-end bus/progress/history variants reduce outgoing-event coverage.
  Retained cancellation and source/account tests remain independently valuable.

Keep these omissions visible when changing the corresponding implementation.
Do not claim that shell/UI mocks validate kernel behavior or actual Android I/O.

## Removed scenarios (audit trail)

- `TestHealthChecksDoNotWriteOrCountTraffic`
- `TestHealthWatchRejectsExitedParentBeforeInitialization`
- `TestHealthRequestNeverReachesRecordsOrUpstream`
- `TestMalformedCleanupRetainsDurableJournal`
- `TestLegacyCleanupFailurePropagatesWithoutDeletingOtherFlow`
- `TestSelectorInjectedAnswerAppearsFromOriginalResolver`
- `TestSelectorMissingContextPassesAllTraffic`
- `TestSelectorAnswersOnlyLocalOutPackets`
- `TestSelectorIPv6TailnetAnswer`
- `TestUdpQueryPayloadExtractsDNSMessage`
- `TestInjectPayloadBoundMatchesIPv4TotalLength`
- `TestReviewTCPResponseWriteEnforcesDeadline`
- `TestReviewListenerCloseClosesAcceptedSockets`
- `TestReviewCapacityBoundsOriginalContextLookup`
- `TestReviewRemovedContextStopsOldAnswersImmediately`
- `TestLocalEndpointUDPAndTCP`
- `TestTCPConnectionSupportsMultipleQueries`
- `TestBindConflictDoesNotWriteReadyState`
- `TestConfigAndContextValidation`
- `TestHijackQueueFailureDegradesWithoutPanic`
- `TestMalformedQuestionAndTruncation`
- `TestShutdownCaptureRetriesBoundedly`
- `TestServeQueueFlagOverridesConfig`
- `TestHealthStateSurfacesPassedAnswers`
- `TestTailnetRecordsRejectNonRoutableHostAddresses`
- `TestFlowContextSharesOneValidationBeforeWrite`
- `TestSocksHTTPSDeadlineAndRefusal`
- `TestSocksCheckAndroidTrustDirectoryPrecedence`
- `TestSocksCheckRejectsUnsupportedInputsBeforeNetwork`
- `TestSocketDiagUsesConnectedFullTupleAndKernelFilter`
- `TestSocketProbeRequiresIPv4Only`
- `TestQueueRegistrationDiagnosesOnlyUnsupportedMetadataACK`
- `TestCaptureDoesNotMatchOnlySourcePort`
- `TestFlowCapacityAndExpiryAreBounded`
- `TestConntrackReplyAcceptsKernelSuccessAcknowledgement`
- `TestContextCheckingUDPSocketRetainsDatagramFraming`
- `TestNetdFileCredentialsUseDiagnosedSocketUID`
- `TestWriteRevalidatesFlowOncePerWrite`
- `TestRouteRequestIncludesOriginalUIDMarkAndTransport`
- `TestRouteProbeRequiresIPv4Only`
- `TestPacketTuplePreservesCompleteFlowKey`
- `TestLookupAddressesRequireExactEndpoints`
- `TestUDPListenerExposesExactLocalAddressForConntrack`
- `TestVerifyRejectsAllInvalidInputsBeforeProbing`
- `TestVerifyReportsIndependentRows`
- `TestVerifyUDPTimeoutDoesNotSkipTCP`
- `TestArchiveNeverReusesDestination`
- `TestArchiveInclusiveExpandedAndMemberBoundaries`
- `TestArtifactBinaryRoundTripAndDelete`
- `TestArtifactRejectsLimitsAndInvalidTokens`
- `TestArtifactExtractionPreservesDigestAndSource`
- `TestArtifactStoreQuotaAndIncompleteExpiry`
- `TestStageLengthPermissionsDeletionAndInboxRead`
- `TestSendSourceRejectsReceiverDroppedNames`
- `TestStageExpirationPreservesActiveAndCurrentWrites`
- `TestInboxListNamesMetadataAndOrdering`
- `TestInboxListInvalidUTF8IsIgnored`
- `TestInboxEntryRacesAndMetadataFailure`
- `TestInboxListBoundsOnlyReturnedFiles`
- `TestReceiveStatusModes`
- `TestStatsCounterTypeAndGenerationParity`
- `TestStatsSummaryRejectsOversizedInputWithoutCache`
- `TestStatsSummarySkipsWrongTypeRows`
- `TestStatsTempSweepRemovesStaleLeftovers`
- `TestStatsOrderingRejectsOversizedRowsWithoutOutput`
- `TestFinalTransferQueriesIgnoreUnrelatedHistoryAndActiveLock`
- `TestTransferQueryWaitsForStateOwnerBeforeReading`
- `TestInterruptedRecoveryKeepsCancelMarkerOnSaveFailure`
- `TestTransferQueriesRejectInvalidSelectedRecord`
- `TestTransferHistoryRemovalWaitsForStateOwner`
- `TestTransferSaveDetectsShortWrite`
- `TestSendStopCancelsCorruptRecordIdentities`
- `TestStaleWedgedStageForceCollected`
- `TestOutgoingProgressRequiresExactIDAndPeer`
- `TestTransferHistoryBoundedAndInstallingRejected`
- `TestUnixBusDeliversExactOutgoingBytesBeforeHTTPCompletion`
- `TestWorkerDeathRecoveredFromReleasedLock`

## Validation of this reduction

Both modules compile; `go vet ./...` passes for both. `go test -race -count=1`
was attempted for both complete suites. This host denies Unix sockets and one
netlink query with `operation not permitted`, affecting these eight retained tests:

- TestQuiesceAuthenticatesInstanceAndKeepsListener
- TestServeTerminatesAfterBoundedCleanupRetries
- TestLookupRequiresExactConntrackReplyAndObservedID
- TestLocalAPIMultipartHTTPAuthorityAndFailedOnlyRetry
- TestLocalAPIAccountAndSourceRevalidation
- TestDetachedWorkerCancelAndInterruption
- TestBusUnavailableStaysUnknownUntilHTTPAndStageSuccessCleans
- TestSourceChangesDuringHTTPUploadAreNotReportedSuccessful

A second race run, excluding exactly these eight via the command-line `-skip`
option, passed for both modules. No skip was added to source or CI. Existing
privileged scenarios may additionally skip unless their required gate is enabled;
this local result is not proof of kernel or Android behavior.
