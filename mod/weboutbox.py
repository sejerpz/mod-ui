# SPDX-FileCopyrightText: 2026 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""What mod-ui writes to the web UI while the page has not answered "data_ready".

mod-host is re-armed whether or not the page answers, so a hidden or suspended tab
would otherwise get every batch, and a tab that stops reading would make Tornado
buffer them without limit. While an answer is pending, value messages are held,
only the newest per key, and written all at once when the answer comes. Every other
message keeps its order: whatever is held is written first, so held values never
cross it.

Not in session.py because that module builds the Session (HMI port, Host) when it is
imported, and this can be tested on its own (test/test_weboutbox.py).
"""

from collections import deque, OrderedDict

# Kinds a newer message replaces while held, with how many leading words make the key:
# param_set/output_set INSTANCE SYMBOL VALUE, patch_set INSTANCE WRITABLE URI TYPE VALUE
# (keyed without WRITABLE, see _key), pmdb PORT DB, plugin_cpu_load INSTANCE LOAD;
# the others carry their whole state.
MERGED = {
    "param_set": 3,
    "output_set": 3,
    "patch_set": 4,
    "pmdb": 2,
    "plugin_cpu_load": 2,
    "transport": 1,
    "stats": 1,
    "sys_stats": 1,
}
# Merged by keeping the highest value, the peak since the page last saw one.
PEAK = ("pmdb", "plugin_cpu_load")
# Written at once, with nothing held flushed before them.
CONTROL = ("data_ready", "ping", "stop")
# Plugin log lines kept while held, the newest ones.
MAX_LOGS = 100


def _key(msg, words):
    key = msg.split(" ", words)[:words]
    if key[0] == "patch_set":
        # one parameter per instance and uri, the writable flag aside
        key = key[:2] + key[3:]
    return tuple(key)


def _value(msg):
    return float(msg.rsplit(" ", 1)[1])


class WebOutbox(object):
    def __init__(self, write):
        self.write = write
        self.held = OrderedDict()  # 3.4 dicts have no order
        self.logs = deque(maxlen=MAX_LOGS)

    def send(self, msg, holding):
        cmd = msg.split(" ", 1)[0]
        if cmd in CONTROL:
            self.write(msg)
            return
        if holding and cmd == "log":
            self.logs.append(msg)
            return
        words = MERGED.get(cmd)
        if not holding or words is None:
            self.flush()
            self.write(msg)
            return
        key = _key(msg, words)
        old = self.held.get(key)
        if cmd in PEAK and old is not None and _value(old) >= _value(msg):
            return
        # a key already held keeps its place
        self.held[key] = msg

    def before_broadcast(self, msg):
        """Call before writing msg, from one page, to the others: a held older value must not
        overwrite it later, and nothing held may cross a message that keeps its order."""
        words = MERGED.get(msg.split(" ", 1)[0])
        if words is None:
            self.flush()
        else:
            self.held.pop(_key(msg, words), None)

    def flush(self):
        msgs = list(self.logs) + list(self.held.values())
        self.clear()
        for msg in msgs:
            self.write(msg)

    def clear(self):
        self.held.clear()
        self.logs.clear()
