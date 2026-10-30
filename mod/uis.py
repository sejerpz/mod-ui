#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""User interfaces (experimental): complete copies of html/ installed under the data folder,
one folder per id, and the choice of which one the unit serves.

An installed UI is a full fork of the front end. Its templates are rendered by tornado, which
runs Python, so installing one means trusting its author with the device.

Standard library only: mod.settings imports this while the mod package is still initialising.
"""

import os
import re
import shutil
import zipfile
import zlib
from urllib.parse import urlparse

NAME_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,31}$')
MAX_FILES = 5000
MAX_BYTES = 50*1024*1024

def check_name(name):
    if not NAME_RE.match(name or ''):
        raise ValueError("Invalid name: use up to 32 lowercase letters, digits, '-' or '_'")

def is_installed(uis_dir, name):
    return bool(NAME_RE.match(name or '')) and os.path.isfile(os.path.join(uis_dir, name, 'index.html'))

def list_uis(uis_dir):
    if not os.path.isdir(uis_dir):
        return []
    return sorted(name for name in os.listdir(uis_dir) if is_installed(uis_dir, name))

def install_zip(uis_dir, name, fileobj):
    """Install the html/ tree inside a zip archive as `name`, replacing a previous install.
    Accepts a GitHub source archive (<repo>-<branch>/html/...) or the html/ contents directly."""
    check_name(name)

    # the messages of zipfile and of the OS name files from the archive, and Settings shows the
    # message as HTML, so they are not passed on
    try:
        _install_zip(uis_dir, name, fileobj)
    except (zipfile.BadZipFile, RuntimeError, EOFError, zlib.error):
        raise ValueError("Not a zip archive, or one that cannot be read (encrypted or damaged)")
    except OSError as e:
        raise ValueError("Could not write the files: %s" % (e.strerror or "unknown error"))

def _install_zip(uis_dir, name, fileobj):
    with zipfile.ZipFile(fileobj) as zf:
        infos = zf.infolist()

        for info in infos:
            # the message does not repeat the path: Settings shows it as HTML
            if info.filename.startswith('/') or '..' in info.filename.split('/'):
                raise ValueError("Archive contains an absolute or '..' path")

        # the shortest index.html that is either at the top or inside a folder named html
        roots = [info.filename for info in infos if re.match(r'((.*/)?html/)?index\.html$', info.filename)]
        if not roots:
            raise ValueError("No html/index.html found in archive")
        prefix = min(roots, key=len)[:-len('index.html')]

        members = [info for info in infos if info.filename.startswith(prefix)]
        if len(members) > MAX_FILES:
            raise ValueError("Archive has more than %i files" % MAX_FILES)
        if sum(info.file_size for info in members) > MAX_BYTES:
            raise ValueError("Archive is larger than %i MB" % (MAX_BYTES // (1024*1024)))

        tmp = os.path.join(uis_dir, '.tmp-' + name)
        old = os.path.join(uis_dir, '.old-' + name)
        dst = os.path.join(uis_dir, name)
        shutil.rmtree(tmp, True)
        os.makedirs(tmp)

        try:
            zf.extractall(tmp, members)
            # on disk before it can be chosen, so a power cut after switching leaves no empty files
            if hasattr(os, 'sync'):
                os.sync()
            shutil.rmtree(old, True)
            if os.path.exists(dst):
                os.rename(dst, old)
            os.rename(os.path.join(tmp, prefix), dst)
            # the install time is part of the asset cache key, see CUSTOM_UI_VERSION_SUFFIX in webserver.py
            os.utime(dst, None)
        finally:
            shutil.rmtree(tmp, True)
            shutil.rmtree(old, True)

def remove_ui(uis_dir, name):
    check_name(name)
    shutil.rmtree(os.path.join(uis_dir, name), True)

def read_active(uis_dir, active_file):
    """The installed UI chosen in active_file, or None for the default one."""
    try:
        with open(active_file, 'r') as fh:
            name = fh.read().strip()
    except IOError:
        return None
    return name if is_installed(uis_dir, name) else None

def set_active(uis_dir, active_file, name):
    """Choose an installed UI, or the default one with an empty name. Applies on the next start."""
    if not name:
        if os.path.exists(active_file):
            os.remove(active_file)
        return
    if not is_installed(uis_dir, name):
        raise ValueError("This user interface is not installed")
    with open(active_file, 'w') as fh:
        fh.write(name + '\n')
        fh.flush()
        os.fsync(fh.fileno())

def same_origin(origin, host):
    """Browsers send Origin on cross-site POSTs; refuse those so another site cannot install a UI."""
    return origin is None or urlparse(origin).netloc == host
