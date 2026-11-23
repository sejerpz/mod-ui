#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""mod.weboutbox: what reaches the web UI while a "data_ready" answer is pending.

Run with:  python3 -m unittest discover -s test -p 'test_*.py'
"""

import os
import sys
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from mod.weboutbox import WebOutbox


class Sockets(object):
    """Session's side: a list of open pages, each a list of what it was sent."""
    def __init__(self):
        self.open = [[]]

    def write(self, msg):
        for ws in self.open:
            ws.append(msg)


def outbox():
    out = []
    return WebOutbox(out.append), out


class TestWebOutbox(unittest.TestCase):

    def test_merge_per_key(self):
        box, out = outbox()
        for msg in ("param_set a x 1", "param_set b x 5", "param_set a x 2",
                    "output_set a y 0.5", "output_set a y 0.7",
                    "patch_set a 1 urn:p s hello world", "patch_set a 0 urn:p s other",
                    "patch_set a 1 urn:q s more", "patch_set b 1 urn:p s more", "patch_set a 1 urn:p s bye",
                    "transport 1 4 120 none", "transport 0 4 90 none",
                    "stats 10.0 0", "stats 12.5 1", "sys_stats 1 2 3", "sys_stats 4 5 6"):
            box.send(msg, True)
        assert out == []
        box.flush()
        # newest value per key, in the place of the key's first message;
        # patch_set per (instance, uri), whatever the writable flag
        assert out == ["param_set a x 2", "param_set b x 5", "output_set a y 0.7",
                       "patch_set a 1 urn:p s bye", "patch_set a 1 urn:q s more", "patch_set b 1 urn:p s more",
                       "transport 0 4 90 none", "stats 12.5 1", "sys_stats 4 5 6"], out

    def test_ordered_flushes_everything_held_before_it(self):
        box, out = outbox()
        for msg in ("param_set a x 1", "param_set a x 2", "add X", "param_set a x 3",
                    "connect p q", "connect p q", "remove X"):
            box.send(msg, True)
        # ordered messages are never merged or held, and nothing held crosses one
        assert out == ["param_set a x 2", "add X", "param_set a x 3",
                       "connect p q", "connect p q", "remove X"], out
        box.flush()
        assert len(out) == 6

    def test_control_written_at_once_and_flushes_nothing(self):
        box, out = outbox()
        box.send("param_set a x 1", True)
        for msg in ("data_ready 5", "ping", "stop"):
            box.send(msg, True)
        assert out == ["data_ready 5", "ping", "stop"]
        box.flush()
        assert out[-1] == "param_set a x 1"

    def test_logs_capped_to_newest(self):
        box, out = outbox()
        for i in range(150):
            box.send("log 1 line %d" % i, True)
        box.send("param_set a x 1", True)
        box.flush()
        assert out == ["log 1 line %d" % i for i in range(50, 150)] + ["param_set a x 1"], out
        # not held: written through, in order
        box.send("log 1 now", False)
        assert out[-1] == "log 1 now"

    def test_peaks_merged_by_maximum(self):
        box, out = outbox()
        for msg in ("pmdb /graph/p -20.000000", "pmdb /graph/p -30.000000", "pmdb /graph/q -50.000000",
                    "plugin_cpu_load a 5.000000", "plugin_cpu_load a 3.000000"):
            box.send(msg, True)
        box.flush()
        assert out == ["pmdb /graph/p -20.000000", "pmdb /graph/q -50.000000",
                       "plugin_cpu_load a 5.000000"], out
        del out[:]
        for msg in ("pmdb /graph/p -20.000000", "pmdb /graph/p -10.000000",
                    "plugin_cpu_load a 5.000000", "plugin_cpu_load a 7.000000"):
            box.send(msg, True)
        box.flush()
        assert out == ["pmdb /graph/p -10.000000", "plugin_cpu_load a 7.000000"], out

    def test_not_holding_writes_everything_through(self):
        box, out = outbox()
        msgs = ["param_set a x 1", "param_set a x 2", "pmdb p -30", "pmdb p -20", "log 1 hi", "add X"]
        for msg in msgs:
            box.send(msg, False)
        assert out == msgs

    def test_flush_on_answer(self):
        box, out = outbox()
        box.send("param_set a x 1", True)
        box.send("log 1 hi", True)
        box.flush()                     # Session.ws_data_ready, before holding stops
        assert out == ["log 1 hi", "param_set a x 1"]
        box.flush()
        assert len(out) == 2            # written once only
        box.send("param_set a x 2", False)
        assert out[-1] == "param_set a x 2"

    def test_broadcast_from_another_page(self):
        box, out = outbox()
        box.send("param_set a x 1", True)
        box.send("param_set b x 1", True)
        # the page's own newer value must not be overwritten later by the held one
        box.before_broadcast("param_set a x 9")
        box.send("patch_set a 0 urn:p s old", True)
        box.before_broadcast("patch_set a 1 urn:p s new")
        assert out == []
        box.flush()
        assert out == ["param_set b x 1"]
        # anything else keeps its order: what is held goes first
        box.send("param_set c x 1", True)
        box.before_broadcast("plugin_pos c 10 20")
        assert out[-1] == "param_set c x 1"

    def test_disconnect_and_reconnect(self):
        sockets = Sockets()
        box = WebOutbox(sockets.write)
        box.send("param_set a x 1", True)
        box.send("log 1 old", True)
        old = sockets.open[0]
        # last page closes: Session clears the outbox, Host.end_session stops holding
        box.clear()
        sockets.open = []
        box.flush()
        assert old == []
        # a new page gets the state dump from Host directly, then only what is new
        sockets.open = [[]]
        box.send("param_set a x 2", False)
        assert sockets.open[0] == ["param_set a x 2"]
        # several pages share one outbox: a flush reaches every page open at that time
        sockets.open.append([])
        box.send("param_set a x 3", True)
        box.flush()
        assert [ws[-1] for ws in sockets.open] == ["param_set a x 3", "param_set a x 3"]

    def test_memory_bounded_while_holding(self):
        box, out = outbox()
        for i in range(20000):
            box.send("output_set p%d meter %f" % (i % 50, i), True)
            box.send("pmdb /graph/p%d %f" % (i % 4, -i), True)
            box.send("log 1 line %d" % i, True)
        assert out == []
        assert len(box.held) == 54 and len(box.logs) == 100


if __name__ == "__main__":
    unittest.main()
