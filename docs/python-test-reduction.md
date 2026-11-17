# Python regression suite reduction

Baseline: `544e2ab` (508 discovered `test_*` methods). Target: 254 methods (50% reduction). No tests are renamed, disabled, marked skipped, or packed into fewer methods. Existing parameter rows inside retained tests are unchanged. Counts are test methods, not assertions or parameter rows.

## Selection policy

Keep destructive-operation fencing, crash rollback, identity secrecy, account isolation, file/path confinement, process ownership, fail-closed networking and a representative success path. Remove lower-priority compatibility, formatting, performance and alternate-path permutations; remove repeated adapter checks where a deeper retained test checks the same boundary. This deliberately reduces regression coverage: removed cases are not all exact duplicates. Product behavior and CI discovery remain unchanged.

## Exact removal ledger

### `test_api_entrypoints.py`: 10 → 6

Removed:
- `test_taildrop_history_and_batch_dispatch_contracts`
- `test_independent_device_read_ignores_broken_saved_configuration`
- `test_host_process_stamp_survives_stop_and_rejects_zombies`
- `test_exit_routing_cancels_owned_descendants_without_success_payload`

### `test_artifacts.py`: 7 → 6

Removed:
- `test_token_restore_rejects_archive_links_without_mutating_source`

### `test_backup_api.py`: 20 → 11

Removed:
- `test_preview_is_read_only_and_shows_validated_config_diff_and_hook_names`
- `test_restore_requires_both_preview_hashes`
- `test_restore_rejects_archive_symlink_even_with_matching_hashes`
- `test_restore_rejects_links_before_extraction`
- `test_restore_retains_snapshot_and_marks_restart`
- `test_failed_backup_removes_partial_archive`
- `test_backup_verification_and_shared_storage_failures_are_actionable`
- `test_file_delete_clear_read_lifecycle`
- `test_file_ops_reject_path_escape`

### `test_coexist_api.py`: 5 → 3

Removed:
- `test_uses_applied_endpoints_and_exact_current_membership_without_writes`
- `test_only_safe_local_listener_states_enable_snippet_and_probe`

### `test_config_api.py`: 22 → 11

Removed:
- `test_parser_preserves_empty_lists_and_final_line`
- `test_dns_modes_roundtrip_and_upgrade_default`
- `test_old_route_table_fails_without_rewriting_disk`
- `test_auto_refresh_preserves_legacy_disk_key`
- `test_cidr_normalization_matches_network_semantics_and_preserves_hosts`
- `test_account_json_and_stderr_are_preserved`
- `test_settings_and_routes_return_public_schema`
- `test_package_inventory_preserves_uid_and_order`
- `test_context_live_status_is_independent_and_reports_unknown`
- `test_context_rules_failure_releases_restore_lock`
- `test_wait_for_preserves_arguments_and_bounds_failure`

### `test_context.py`: 29 → 14

Removed:
- `test_validation_accepts_supported_syntax_and_eof`
- `test_exit_node_zone_id_is_rejected_at_parse_time`
- `test_stop_propagates_cleanup_failure_without_loading_config`
- `test_start_propagates_claim_failure_but_duplicate_is_success`
- `test_absent_empty_or_malformed_rules_never_run_actions`
- `test_eof_rule_executes_once_and_success_is_cached`
- `test_up_uses_applied_service_start_and_down_uses_stop`
- `test_partial_retry_replays_idempotent_actions_in_order`
- `test_context_change_after_partial_success_reapplies_previous_context`
- `test_resident_retries_using_existing_loop`
- `test_snapshot_change_reapplies_identical_rules`
- `test_result_publication_failure_leaves_no_partial_json_and_status_tolerates_corruption`
- `test_compact_wifi_status_avoids_full_dump_and_cellular_only_rules_skip_wifi_queries`
- `test_wifi_command_capability_is_cached_but_transient_failure_recovers`
- `test_resident_throttles_screen_off_without_replaying_successful_actions`

### `test_contract_drift.py`: 11 → 4

Removed:
- `test_dispatched_commands_are_advertised`
- `test_advertised_commands_are_dispatched`
- `test_bridge_queries_exist_in_dispatch`
- `test_bridge_mutations_exist_in_dispatch`
- `test_control_commands_exist_in_dispatch`
- `test_api_read_commands_exist_in_dispatch`
- `test_instrumentation_bottom_navigation_matches_current_routes`

### `test_control_operations.py`: 18 → 11

Removed:
- `test_live_read_probe_does_not_block_mutation_admission`
- `test_taildrop_history_and_batch_durable_write_contracts`
- `test_taildrop_write_operations_reject_wrong_argument_counts_and_large_batches`
- `test_worker_ignores_hangup_after_acceptance`
- `test_backend_info_and_stop_work_with_bad_configuration`
- `test_private_retention_expires_without_replay_and_enforces_capacity`
- `test_fixed_capability_and_readonly_hooks`

### `test_diag_collect_args.py`: 1 → 0

Removed:
- `test_mode_in_slot_one_names_mode_not_a_directory`

### `test_diagnostics.py`: 3 → 2

Removed:
- `test_summary_distinguishes_stopped_unknown_and_failed_components`

### `test_dns_capabilities.py`: 9 → 3

Removed:
- `test_native_table_never_loads_module`
- `test_missing_exact_module_does_not_load_similar_ipv6_modules`
- `test_loader_success_without_nat_falls_back`
- `test_loader_failure_and_missing_loader_fall_back`
- `test_ipv6_disabled_never_scans_or_loads_modules`
- `test_dns_status_observes_capability_without_loading`

### `test_dns_conflicts.py`: 9 → 5

Removed:
- `test_disjoint_and_unreachable_rules_do_not_conflict`
- `test_connmark_named_chains_only_conflict_when_rules_use_reserved_bit`
- `test_active_network_change_invalidates_legacy_upstream`
- `test_batch_inventory_keeps_categories_exclusions_and_package_names`

### `test_dns_hijack.py`: 7 → 3

Removed:
- `test_hijack_queues_udp_without_nat_marks_or_redirects`
- `test_hijack_v6_survives_missing_nat_module`
- `test_probe_hijack_records_boot_scoped_verdict`
- `test_hijack_guard_failure_cleans_queue_chain`

### `test_dns_journal_install.py`: 15 → 8

Removed:
- `test_uninstall_only_removes_exact_owned_legacy_links`
- `test_uninstall_stop_or_backup_failure_retains_all_legacy_links`
- `test_uninstall_legacy_link_removal_failure_retains_runtime`
- `test_repeated_uninstall_cleans_dangling_links_without_changing_backups`
- `test_missing_journal_removes_stale_ownership_backup`
- `test_restore_publication_failure_is_retryable_for_both_files`
- `test_legacy_identity_never_receives_a_backup_journal`

### `test_dns_modern.py`: 35 → 16

Removed:
- `test_queue_failure_stays_repairable_after_guard_removed_rules`
- `test_local_and_missing_queue_have_usable_listener_without_capture_rules`
- `test_queue_failure_after_successful_probe_keeps_local_endpoint`
- `test_daemon_down_stop_preserves_restore_journal_without_blocking`
- `test_initializing_profile_without_self_retains_restore_journal`
- `test_missing_ipv6_nat_retains_ipv4_capture_and_ipv6_listener_preference`
- `test_unchanged_reconciliation_does_not_change_prefs_or_flush_caches`
- `test_status_and_unchanged_reason_do_not_rewrite_runtime_state`
- `test_guard_termination_reaps_its_native_monitor`
- `test_queue_health_loss_requests_cleanup_until_guard_removes_rules`
- `test_native_dns_rule_residue_is_not_reported_as_coexistence`
- `test_queue_is_last_after_other_mark_rules_and_reconciles_later_appends`
- `test_unresponsive_helper_is_unready_and_guard_withdraws_capture`
- `test_saved_mode_and_port_keep_reporting_actual_running_listener`
- `test_state_from_a_different_process_or_listener_port_is_not_ready`
- `test_other_root_dns_interception_keeps_local_endpoint_without_bypassing_policy`
- `test_capability_error_never_leaks_a_stale_boot_reason`
- `test_capture_mark_conflict_turns_a_passing_probe_into_a_no_verdict`
- `test_queue_ready_short_circuits_the_probe`

### `test_exit_routing.py`: 14 → 7

Removed:
- `test_read_reuses_snapshot_and_reports_profile_changes_as_unknown`
- `test_exit_read_envelope_scopes_identity_and_rejects_config_mismatch`
- `test_pinned_auto_schema_and_unknown_profile_fail_closed`
- `test_modes_scope_and_ipv6_report_coverage_honestly`
- `test_trial_manual_helper_claim_and_repeated_context_change`
- `test_failed_trial_write_does_not_restore_over_original`
- `test_failed_clear_keeps_policy_failure_visible`

### `test_identity_api.py`: 5 → 5

Removed:

### `test_lifecycle.py`: 25 → 12

Removed:
- `test_postinstall_starts_all_residents_and_preserves_run`
- `test_reload_only_clears_the_revision_it_applied`
- `test_installer_success_removes_only_exact_owned_dev_links`
- `test_installer_dev_cleanup_failure_warns_without_rollback_or_skipping_postinstall`
- `test_installer_pid_scan_ignores_vendor_proc_entries_with_numeric_prefixes`
- `test_installer_pid_scan_with_no_numeric_entries_is_quiet`
- `test_interrupted_journal_publication_cleans_gate_and_private_temporary`
- `test_begin_install_never_reuses_an_existing_backup`
- `test_boot_keeps_install_lock_until_startup_returns`
- `test_active_module_receives_only_stable_boot_files`
- `test_quiesce_is_internal_and_does_not_create_a_user_stop_hold`
- `test_copytruncate_keeps_existing_writer_on_active_inode`
- `test_installer_exposes_commands_without_sourced_libraries`

### `test_lifecycle_fixes.py`: 20 → 5

Removed:
- `test_exe_and_scripts_path_forms_still_match`
- `test_systemless_and_module_bin_paths_match`
- `test_staged_modpath_bin_path_matches`
- `test_bare_names_match_only_after_an_interpreter`
- `test_dead_choosing_owner_is_reaped`
- `test_dead_choosing_recheck_during_scan`
- `test_identity_accepts_managed_and_staging_dirs`
- `test_enable_ensures_watcher`
- `test_unknown_status_argument_is_a_usage_error`
- `test_stopped_reported_even_with_broken_configuration`
- `test_running_reported_with_broken_configuration`
- `test_ipv6_endpoint_matches_the_full_address`
- `test_start_rewrite_missing_pidfile_for_live_daemon`
- `test_mod_desc_replaces_only_the_first_bracketed_prefix`
- `test_uninstall_removes_stale_dns_backup_without_state`

### `test_lock_recovery.py`: 12 → 7

Removed:
- `test_dead_legacy_primary_and_orphan_reaper_do_not_block_recovery`
- `test_dead_choosing_numeric_and_temporary_tickets_are_reaped`
- `test_live_choosing_owner_is_respected_until_it_dies`
- `test_orphaned_reaper_cannot_bypass_a_live_owners_ticket`
- `test_controllers_release_their_own_lock_domains`

### `test_network.py`: 27 → 10

Removed:
- `test_exit_routing_keeps_eight_cli_validation_branch_without_mutations`
- `test_exit_public_defaults_follow_selected_identity_and_clear`
- `test_exit_public_defaults_preserve_scope_and_exemptions`
- `test_safe_teardown_corrupt_state`
- `test_route_status_notes_skipped_defaults_and_scopes_ipv6`
- `test_dns_detection_families_tables_and_targets`
- `test_compat_checks_use_applied_runtime_not_saved_settings`
- `test_installed_proxy_is_inventory_until_dns_conflict_exists`
- `test_dns_cache_flush_requires_verified_interface_and_targets_existing_networks`
- `test_pinned_native_dns_is_compatible_but_other_quad100_rules_are_not`
- `test_dns_binary_falls_back_to_trusted_system_paths`
- `test_dns_exact_aliases_migrate_wildcards_and_reconcile_hosts`
- `test_modern_cleanup_failure_does_not_retain_legacy_listener`
- `test_dns_missing_ipv6_nat_retains_ipv4_and_recovers_when_available`
- `test_dns_live_process_preserves_degraded_and_recovers`
- `test_dns_start_tailnet_loss_preserves_stop_failure_reason`
- `test_dns_probe_arms_load_applied_runtime_config`

### `test_network_api.py`: 38 → 17

Removed:
- `test_exit_empty_controller_result_is_error`
- `test_light_status_uses_one_cli_and_shares_identity_scoped_peer_list`
- `test_failed_deep_helper_does_not_publish_success_payload`
- `test_legacy_account_transition_does_not_require_new_helper`
- `test_watchdog_respects_explicit_nonrepairable_dns_state`
- `test_malformed_subnet_snapshot_does_not_claim_an_empty_known_result`
- `test_subnet_setting_failure_and_stopped_daemon_never_claim_applied`
- `test_routes_set_normalizes_cidrs_and_reports_unapplied_ipv6`
- `test_routes_reload_failure_is_distinct_from_unapplied_ipv6`
- `test_routes_report_applied_ipv6_while_desired_setting_is_pending`
- `test_dns_status_preserves_configuration_and_native_capability`
- `test_status_reports_live_daemon_without_socket_as_unreachable`
- `test_peer_ping_reports_the_actual_reply_path_for_each_address_family`
- `test_peer_lists_keep_all_addresses_when_local_ipv6_is_disabled`
- `test_peer_lists_carry_the_established_path_fields_verbatim`
- `test_status_rechecks_process_after_localapi_failure`
- `test_status_preserves_startup_login_and_machine_approval_states`
- `test_dns_probe_reports_probe_failures_as_string_reasons`
- `test_dns_probe_uses_cached_capability_error_and_nulls_on_success`
- `test_dns_probe_success_keeps_null_reasons`
- `test_exitnode_set_rejects_option_lookalikes_before_the_controller`

### `test_network_snapshot.py`: 5 → 2

Removed:
- `test_system_default_changes_with_both_links_retained`
- `test_dns_order_ipv6_and_changes_remain_visible`
- `test_old_android_record_keeps_active_id_authority`

### `test_operation_phase.py`: 3 → 3

Removed:

### `test_power.py`: 9 → 3

Removed:
- `test_independent_switches_preserve_upgrade_defaults_and_require_apply`
- `test_power_intervals_keep_user_limits_and_normal_watchdog_avoids_display_probe`
- `test_watchdog_claim_failure_is_not_a_successful_disabled_start`
- `test_watchdog_quiet_rounds_do_not_scan_processes_or_rewrite_state`
- `test_log_monitor_backs_off_when_quiet_and_speeds_up_near_limit`
- `test_status_exposes_runtime_power_preferences_even_when_stopped`

### `test_process_api.py`: 22 → 10

Removed:
- `test_backend_keeps_existing_system_cgroup`
- `test_child_discovery_reads_parent_and_starttime_from_one_proc_record`
- `test_fast_cli_does_not_wait_for_timeout_monitor`
- `test_fast_cli_waits_for_monitor_trap_before_stopping_it`
- `test_multicall_cli_is_not_mistaken_for_daemon`
- `test_proc_command_snapshot_finishes_without_waiting_for_eof`
- `test_process_lookup_skips_foreign_or_vanished_candidates_before_read`
- `test_process_identity_handles_spaces_and_parentheses`
- `test_inotify_identity_requires_exact_handler_and_module_arguments`
- `test_stop_by_pids_terminates_the_bound_process`
- `test_stop_by_pids_never_signals_a_recycled_identity`
- `test_expired_requests_never_restart_and_gc_is_bounded`

### `test_receive_monitor.py`: 15 → 9

Removed:
- `test_hot_preference_defaults_validation_and_pending_isolation`
- `test_failed_locked_and_unavailable_scans_preserve_observations`
- `test_large_inbox_snapshot_is_not_passed_in_one_argv`
- `test_completed_metadata_edit_is_not_a_new_arrival`
- `test_first_pending_snapshot_is_baseline_not_old_notification`
- `test_restart_baseline_preserves_generation_for_identical_later_arrival`

### `test_release.py`: 7 → 5

Removed:
- `test_native_build_failure_never_creates_an_incomplete_package`
- `test_explicit_update_only_creates_review_candidate`

### `test_restore_recovery.py`: 5 → 4

Removed:
- `test_context_writer_recovers_before_creating_missing_live_directory`

### `test_runtime_config.py`: 37 → 19

Removed:
- `test_staged_settings_load_staged_libraries_and_validate_live_config`
- `test_pending_settings_never_replace_recovery_snapshot`
- `test_warm_start_uses_runtime_even_with_invalid_desired`
- `test_resident_reload_does_not_parse_broken_desired_settings`
- `test_pending_marker_rejects_unlocked_writer`
- `test_disable_callback_uses_internal_stop_and_preserves_failures`
- `test_disable_callback_covers_rename_events_and_enable_by_absence`
- `test_conf_parse_tolerates_crlf_indented_comments_and_key_whitespace`
- `test_incompatible_native_hot_routes_are_not_promoted`
- `test_hot_promotion_rejects_nonregular_pointer`
- `test_context_up_never_clears_user_hold_and_internal_stop_does_not_create_one`
- `test_live_daemon_requires_working_local_api_but_not_login`
- `test_start_without_optional_timeout_accepts_answering_local_api`
- `test_context_hold_does_not_supersede_trial_or_hide_timeout`
- `test_expiry_and_failed_health_preserve_later_saves`
- `test_status_recovers_dead_worker_once_without_waiting_for_rollback`
- `test_rolled_back_saved_candidate_stays_pending_after_lost_runtime`
- `test_explicit_new_activation_retires_old_rollback_snapshot`

### `test_socks_check.py`: 3 → 2

Removed:
- `test_durable_probe_preserves_failure_in_terminal_receipt`

### `test_stats.py`: 18 → 7

Removed:
- `test_out_of_order_rows_keep_chronological_counter_semantics`
- `test_cross_hour_and_day_delta_belongs_to_ending_sample`
- `test_hourly_missing_interface_is_not_a_recorded_zero`
- `test_recorded_zero_traffic_remains_a_valid_sample`
- `test_legacy_uid_rx_does_not_become_tx`
- `test_partial_counters_duplicate_ids_and_insertion_order`
- `test_all_query_shapes_reuse_full_summary_cache`
- `test_valid_json_bad_counter_is_skipped_without_temporary_leak`
- `test_bad_counter_row_is_skipped_not_a_baseline`
- `test_outage_rows_are_coalesced_until_recovery_or_date_change`
- `test_stats_power_mode_throttles_without_shortening_configured_intervals`

### `test_taildrop_api.py`: 14 → 6

Removed:
- `test_missing_taildrop_directory_lists_and_clears_empty`
- `test_listing_skips_inflight_internal_and_non_regular_entries`
- `test_initial_listing_and_clear_isolate_existing_incompatible_entries`
- `test_large_inbox_uses_one_native_listing_and_no_per_file_helpers`
- `test_inbox_item_operations_reject_unsupported_names`
- `test_reserved_and_symlink_names_are_not_file_api_items`
- `test_delete_removes_one_and_preserves_others`
- `test_delete_and_clear_reject_removed_directories`

### `test_taildrop_jobs_api.py`: 4 → 3

Removed:
- `test_inbox_stream_has_no_json_wrapper_or_size_cap`

### `test_tun_lifecycle.py`: 13 → 7

Removed:
- `test_failed_rollback_down_is_retried_before_launch`
- `test_missing_interface_recovery_respects_down_failure`
- `test_absent_hooks_preserve_successful_start_stop_and_restart`
- `test_start_and_status_require_runtime_config`
- `test_bundled_hooks_propagate_route_status_and_use_runtime_config`
- `test_bundled_teardown_failure_aborts_restart`

### `test_tun_lock.py`: 2 → 2

Removed:

### `test_verify_backend.py`: 2 → 1

Removed:
- `test_empty_discovery_fails`

### `test_webapi_hardening.py`: 7 → 5

Removed:
- `test_single_file_ops_survive_broken_configuration_like_batch_forms`
- `test_traffic_preserves_a_helper_failure_verdict`

## Coverage tradeoffs

- Statistics: retain reset/generation handling, malformed rows, cache invalidation and runtime enable/route behavior; drop separate time-bucket, legacy RX interpretation, zero-value and throttling permutations.
- Context rules: retain parsing rejection, regular-file safety, user-stop holds, retries after service stop, runtime isolation, argument secrecy and disabled transitions; drop extra retry/order, input-shape and resource-use variants.
- Networking: retain account-fenced rollback, foreign policy preservation, cleanup ownership and no-false-success paths; reduce alternate IPv6/capability combinations and overlapping status/adapter tests. DNS kernel/native tests are a separate suite, not counted here.
- Installation and restore: retain interrupted transaction recovery, protected originals, failed rollback evidence and invalid path/source guards. Remove overlapping publication and link variants, not the recovery mechanism.
- Process and operation control: retain concurrent admission, PID reuse/foreign processes, exactly-once acceptance, unknown outcomes, credentials redaction and cancellation boundaries; reduce repeated syntax/fast-path probes.
- Release and discovery: retain signing/architecture/manifest gate checks, local backup discovery and read-only preview. Remove supplementary packaging permutations and a legacy diagnostic positional-argument test.

## Verification and timing

Full remaining suite executed with the unchanged parallel backend runner: **254 methods, 250 passed, 1 existing mksh-dependent skip, 3 environment-blocked failures/errors**. The three retained ServiceRecovery tests require AF_UNIX sockets; this execution environment rejects socket creation with EPERM. They remain enabled for CI, not removed or weakened to make the run green. Runner wall time: **100.0 seconds** across 37 modules; network 82.2 seconds (10 methods), DNS modern 78.3 seconds (16 methods). These module times overlap. The reduced lifecycle suite was rerun after removal of now-unused extraction helpers: 5 passed. Discovery independently confirms 254 methods.

The prior CI fixture corrections (`dfd18a2`, cherry-picked as `a268241`) are a prerequisite, separate from this reduction. Only tests and this document change. No test discovery filters or extra skips were introduced.

Historical GitHub Verify #78 backend: 38 modules, 344.7 seconds test-runner wall time, four fixture failures. Network module 240.0 seconds and DNS modern 211.1 seconds overlap; these durations must not be summed or treated as a comparable clean baseline. No proportional runtime claim is made from method count.
