#!/usr/bin/env python3
"""Endpoint-contract drift guard.

Four hand-maintained command lists must stay in sync:

* ``tailscale/scripts/foxytail.webapi.sh`` — the ``_webapi_dispatch`` case arms
  that actually run commands.
* ``tailscale/scripts/foxytail.webapi-control.sh`` — ``_control_commands``
  (detached-operation allow-list), the ``_control_validate`` arity table, and
  the ``commands[]`` array advertised by ``cmd_backend_info``.
* ``android/.../WebBridge.java`` — ``validateQuery``/``validateMutation``
  switch allow-lists reached via control.query/control.mutate.
* ``webui/src/api.ts`` — ``READ_COMMANDS`` array.

Names are extracted, never exact text, so the checks tolerate formatting.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEBAPI = ROOT / 'tailscale' / 'scripts' / 'foxytail.webapi.sh'
CONTROL = ROOT / 'tailscale' / 'scripts' / 'foxytail.webapi-control.sh'
BRIDGE = ROOT / 'android' / 'app' / 'src' / 'main' / 'java' / 'dev' / 'foxderin' / 'tail' / 'WebBridge.java'
JAVA_DIR = BRIDGE.parent
API_TS = ROOT / 'webui' / 'src' / 'api.ts'

NAME = re.compile(r'^[a-z][a-z0-9-]*$')
ARM = re.compile(r'^\s*([A-Za-z0-9_ |:*.-]+)\)')

# Dispatched commands with no UI/bridge caller and no in-app invocation:
# dead surface kept for backend compatibility.
KNOWN_DEAD = {'peers', 'exitnodes', 'traffic-uids', 'artifact-delete'}


def _function_body(text, signature):
    """Return the body of a POSIX sh function from ``name() {`` to its ``}``."""
    start = text.index(signature)
    end = text.index('\n}\n', start)
    return text[start:end]


def dispatch_commands():
    """Commands with a dispatch case arm in _webapi_dispatch."""
    body = _function_body(WEBAPI.read_text(), '_webapi_dispatch()')
    names = set()
    for line in body.splitlines():
        arm = ARM.match(line)
        if not arm:
            continue
        for part in arm.group(1).split('|'):
            part = part.strip()
            if NAME.match(part):
                names.add(part)
    return names


def control_commands():
    """Detached-operation allow-list from _control_commands."""
    match = re.search(r"^_control_commands='([^']*)'", CONTROL.read_text(), re.M)
    assert match, '_control_commands assignment not found'
    return set(match.group(1).split())


def control_validate_names():
    """Commands with an arity row inside _control_validate."""
    body = _function_body(CONTROL.read_text(), '_control_validate()')
    return set(re.findall(r'([a-z][a-z0-9-]*):[0-9]', body))


def advertised_commands():
    """commands[] advertised by cmd_backend_info (includes $_control_commands)."""
    match = re.search(r'--arg commands "([^"]*)"', CONTROL.read_text())
    assert match, 'cmd_backend_info commands payload not found'
    names = set()
    for token in match.group(1).split():
        if token == '${_control_commands}':
            names |= control_commands()
        elif NAME.match(token):
            names.add(token)
    return names


def _bridge_cases(start_marker, end_marker):
    text = BRIDGE.read_text()
    section = text[text.index(start_marker):text.index(end_marker)]
    return set(re.findall(r'case "([a-z][a-z0-9-]*)"', section))


def bridge_queries():
    return _bridge_cases('void validateQuery', 'void validateMutation')


def bridge_mutations():
    return _bridge_cases('void validateMutation', 'static void count')


def api_read_commands():
    match = re.search(r'READ_COMMANDS\s*=\s*\[(.*?)\]', API_TS.read_text(), re.S)
    assert match, 'READ_COMMANDS array not found in api.ts'
    return set(re.findall(r"'([a-z][a-z0-9-]*)'", match.group(1)))


def java_callers(dispatched):
    """Command literals invoked from the Android side (RootApi/ControlClient).

    WebBridge.java is skipped: its literals are the query/mutation allow-lists,
    already counted by _bridge_cases.
    """
    callers = set()
    for source in JAVA_DIR.glob('*.java'):
        if source.name != 'WebBridge.java':
            callers |= set(re.findall(r'"([a-z][a-z0-9-]+)"', source.read_text()))
    return callers & dispatched


class ContractDrift(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dispatch = dispatch_commands()
        cls.control = control_commands()
        cls.arity = control_validate_names()
        cls.advertised = advertised_commands()
        cls.queries = bridge_queries()
        cls.mutations = bridge_mutations()
        cls.reads = api_read_commands()
        cls.callers = java_callers(cls.dispatch)
        for label, names in [('dispatch', cls.dispatch), ('control', cls.control),
                             ('advertised', cls.advertised), ('queries', cls.queries),
                             ('mutations', cls.mutations), ('reads', cls.reads)]:
            assert names, f'{label} extraction found no commands; parser drifted'

    def test_dispatched_commands_are_advertised(self):
        self.assertEqual(self.dispatch - self.advertised, set(),
                         'dispatched but not advertised in backend-info commands[]')

    def test_advertised_commands_are_dispatched(self):
        self.assertEqual(self.advertised - self.dispatch, set(),
                         'advertised in commands[] but not dispatched')

    def test_bridge_queries_exist_in_dispatch(self):
        self.assertEqual(self.queries - self.dispatch, set(),
                         'control.query allow-list names not dispatched')

    def test_bridge_mutations_exist_in_dispatch(self):
        self.assertEqual(self.mutations - self.dispatch, set(),
                         'control.mutate allow-list names not dispatched')

    def test_bridge_mutations_are_detached_operations(self):
        # control.mutate runs through operation-start, which enforces
        # _control_commands membership inside _control_validate.
        self.assertEqual(self.mutations - self.control, set(),
                         'control.mutate names missing from _control_commands')

    def test_control_commands_exist_in_dispatch(self):
        self.assertEqual(self.control - self.dispatch, set(),
                         '_control_commands entries not dispatched')

    def test_control_validate_arity_matches_operations(self):
        self.assertEqual(self.arity, self.control,
                         '_control_validate arity table out of sync with _control_commands')

    def test_api_read_commands_exist_in_dispatch(self):
        self.assertEqual(self.reads - self.dispatch, set(),
                         'api.ts READ_COMMANDS names not dispatched')

    def test_api_read_commands_are_bridge_queries(self):
        # api.ts sends reads through control.query; the bridge allow-list owns them.
        self.assertEqual(self.reads - self.queries, set(),
                         'api.ts READ_COMMANDS names rejected by validateQuery')

    def test_instrumentation_bottom_navigation_matches_current_routes(self):
        # Instrumentation is assembled, not executed, in the host gate. Catch
        # stale literal navigation targets there before a device run is needed.
        navigation = (ROOT / 'webui/src/navigation.ts').read_text()
        primary = re.search(r"titleKey: 'shell_nav_main', names: \[(.*?)\]", navigation, re.S)
        self.assertIsNotNone(primary, 'primary-navigation parser drifted')
        routes = set(re.findall(r"'([a-z-]+)'", primary.group(1)))
        checks = (ROOT / 'android/app/src/androidTest/java/dev/foxderin/tail/WebViewChecks.java').read_text()
        targets = set(re.findall(r"#bottom-nav a\[href='#/([a-z-]+)'\]", checks))
        self.assertTrue(routes and targets, 'navigation contract extraction found no routes')
        self.assertEqual(targets - routes, set(),
                         'instrumentation clicks a removed primary navigation route')

    def test_no_uncovered_commands(self):
        # Informational: dispatched commands reachable from nowhere get flagged.
        covered = self.queries | self.mutations | self.reads | self.callers | KNOWN_DEAD
        uncovered = self.dispatch - covered
        for name in sorted(uncovered):
            print(f'contract drift: {name} is dispatched but has no UI/bridge caller')
        self.assertEqual(uncovered, set(),
                         'dispatched commands with no UI/bridge caller beyond the known-dead whitelist')


if __name__ == '__main__':
    unittest.main()
