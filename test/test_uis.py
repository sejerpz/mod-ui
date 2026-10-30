#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""mod.uis: installing user interfaces and choosing the one the unit serves.

Run with:  python3 -m unittest discover -s test -p 'test_*.py'
"""

import importlib
import io
import os
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from mod import uis


def make_zip(files):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    data.seek(0)
    return data


class TestInstall(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.uis_dir = os.path.join(self._tmp.name, 'uis')

    def tearDown(self):
        self._tmp.cleanup()

    def read(self, *path):
        with open(os.path.join(self.uis_dir, *path)) as fh:
            return fh.read()

    def test_github_archive_installs_only_the_html_folder(self):
        uis.install_zip(self.uis_dir, 'grid', make_zip({
            'mod-ui-grid-theme/README.rst': 'readme',
            'mod-ui-grid-theme/mod/webserver.py': 'python',
            'mod-ui-grid-theme/html/index.html': 'index',
            'mod-ui-grid-theme/html/js/host.js': 'js',
        }))
        self.assertEqual(self.read('grid', 'index.html'), 'index')
        self.assertEqual(self.read('grid', 'js', 'host.js'), 'js')
        self.assertEqual(sorted(os.listdir(os.path.join(self.uis_dir, 'grid'))), ['index.html', 'js'])

    def test_archive_of_the_html_folder_contents_installs(self):
        uis.install_zip(self.uis_dir, 'mixer', make_zip({'index.html': 'index', 'css/a.css': 'css'}))
        self.assertEqual(self.read('mixer', 'css', 'a.css'), 'css')

    def test_reinstall_replaces_the_previous_files(self):
        uis.install_zip(self.uis_dir, 'mixer', make_zip({'index.html': 'v1', 'old.js': 'old'}))
        uis.install_zip(self.uis_dir, 'mixer', make_zip({'index.html': 'v2'}))
        self.assertEqual(self.read('mixer', 'index.html'), 'v2')
        self.assertFalse(os.path.exists(os.path.join(self.uis_dir, 'mixer', 'old.js')))
        self.assertEqual(os.listdir(self.uis_dir), ['mixer'])

    def test_archive_without_index_html_is_refused(self):
        with self.assertRaises(ValueError):
            uis.install_zip(self.uis_dir, 'broken', make_zip({'mod-ui/html/js/host.js': 'js'}))
        self.assertEqual(uis.list_uis(self.uis_dir), [])

    def test_parent_folder_paths_are_refused(self):
        with self.assertRaises(ValueError):
            uis.install_zip(self.uis_dir, 'evil', make_zip({'../html/index.html': 'index'}))
        with self.assertRaises(ValueError):
            uis.install_zip(self.uis_dir, 'evil', make_zip({'index.html': 'index', 'js/../../../x.js': 'x'}))
        self.assertEqual(uis.list_uis(self.uis_dir), [])

    def test_errors_do_not_echo_archive_paths(self):
        # Settings shows the error as HTML, and the archive comes from a third party
        with self.assertRaises(ValueError) as ctx:
            uis.install_zip(self.uis_dir, 'evil', make_zip({'<img src=x onerror=alert(1)>/../index.html': ''}))
        self.assertNotIn('<', str(ctx.exception))

    @mock.patch.object(uis, 'MAX_BYTES', 10)
    def test_oversized_archive_is_refused(self):
        with self.assertRaises(ValueError):
            uis.install_zip(self.uis_dir, 'big', make_zip({'index.html': 'x' * 11}))
        self.assertEqual(uis.list_uis(self.uis_dir), [])

    @mock.patch.object(uis, 'MAX_FILES', 2)
    def test_archive_with_too_many_files_is_refused(self):
        with self.assertRaises(ValueError):
            uis.install_zip(self.uis_dir, 'many', make_zip({'index.html': '', 'a.js': '', 'b.js': ''}))
        self.assertEqual(uis.list_uis(self.uis_dir), [])

    def test_invalid_names_are_refused(self):
        for name in ('', 'Mixer', '../mixer', '.hidden', 'a' * 33, 'my ui'):
            with self.assertRaises(ValueError):
                uis.install_zip(self.uis_dir, name, make_zip({'index.html': 'index'}))

    def test_list_shows_only_installed_uis(self):
        uis.install_zip(self.uis_dir, 'b', make_zip({'index.html': 'index'}))
        uis.install_zip(self.uis_dir, 'a', make_zip({'index.html': 'index'}))
        os.makedirs(os.path.join(self.uis_dir, 'empty'))
        os.makedirs(os.path.join(self.uis_dir, '.tmp-c'))
        self.assertEqual(uis.list_uis(self.uis_dir), ['a', 'b'])

    def test_remove(self):
        uis.install_zip(self.uis_dir, 'mixer', make_zip({'index.html': 'index'}))
        uis.remove_ui(self.uis_dir, 'mixer')
        self.assertEqual(uis.list_uis(self.uis_dir), [])
        with self.assertRaises(ValueError):
            uis.remove_ui(self.uis_dir, '..')


class TestActive(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.uis_dir = os.path.join(self._tmp.name, 'uis')
        self.active_file = os.path.join(self._tmp.name, 'active-ui')
        uis.install_zip(self.uis_dir, 'mixer', make_zip({'index.html': 'index'}))

    def tearDown(self):
        self._tmp.cleanup()

    def test_default_when_nothing_was_chosen(self):
        self.assertIsNone(uis.read_active(self.uis_dir, self.active_file))

    def test_set_and_read_back(self):
        uis.set_active(self.uis_dir, self.active_file, 'mixer')
        self.assertEqual(uis.read_active(self.uis_dir, self.active_file), 'mixer')
        uis.set_active(self.uis_dir, self.active_file, '')
        self.assertIsNone(uis.read_active(self.uis_dir, self.active_file))

    def test_only_installed_uis_can_be_chosen(self):
        with self.assertRaises(ValueError):
            uis.set_active(self.uis_dir, self.active_file, 'grid')

    def test_default_when_the_chosen_ui_is_gone(self):
        uis.set_active(self.uis_dir, self.active_file, 'mixer')
        uis.remove_ui(self.uis_dir, 'mixer')
        self.assertIsNone(uis.read_active(self.uis_dir, self.active_file))

    def test_default_when_the_file_names_something_else(self):
        with open(self.active_file, 'w') as fh:
            fh.write('../../usr\n')
        self.assertIsNone(uis.read_active(self.uis_dir, self.active_file))


class TestSameOrigin(unittest.TestCase):

    def test_requests_without_origin_are_allowed(self):
        self.assertTrue(uis.same_origin(None, '192.168.51.1'))

    def test_same_host_is_allowed(self):
        self.assertTrue(uis.same_origin('http://192.168.51.1', '192.168.51.1'))
        self.assertTrue(uis.same_origin('http://localhost:8888', 'localhost:8888'))

    def test_other_sites_are_refused(self):
        self.assertFalse(uis.same_origin('https://example.com', '192.168.51.1'))
        self.assertFalse(uis.same_origin('null', '192.168.51.1'))


class TestSettingsServesTheActiveUI(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._environ = dict(os.environ)
        self._settings = sys.modules['mod.settings']
        os.environ['MOD_DATA_DIR'] = self._tmp.name
        os.environ['MOD_HTML_DIR'] = '/usr/share/mod/html/'

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._environ)
        sys.modules['mod.settings'] = self._settings
        self._tmp.cleanup()

    def settings(self):
        sys.modules.pop('mod.settings', None)
        return importlib.import_module('mod.settings')

    def test_default_html_dir(self):
        settings = self.settings()
        self.assertIsNone(settings.ACTIVE_UI)
        self.assertEqual(settings.HTML_DIR, '/usr/share/mod/html/')

    def test_active_ui_html_dir(self):
        uis_dir = os.path.join(self._tmp.name, 'uis')
        uis.install_zip(uis_dir, 'mixer', make_zip({'index.html': 'index'}))
        uis.set_active(uis_dir, os.path.join(self._tmp.name, 'active-ui'), 'mixer')
        settings = self.settings()
        self.assertEqual(settings.ACTIVE_UI, 'mixer')
        self.assertEqual(settings.HTML_DIR, os.path.join(uis_dir, 'mixer'))
        self.assertEqual(settings.DEFAULT_ICON_TEMPLATE,
                         os.path.join(uis_dir, 'mixer', 'resources/templates/pedal-default.html'))


if __name__ == '__main__':
    unittest.main()
