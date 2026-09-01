#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

import os, sys
from os.path import join

DEV_ENVIRONMENT = bool(int(os.environ.get('MOD_DEV_ENVIRONMENT', False)))
DEV_HMI = bool(int(os.environ.get('MOD_DEV_HMI', DEV_ENVIRONMENT)))
DEV_HOST = bool(int(os.environ.get('MOD_DEV_HOST', DEV_ENVIRONMENT)))

# If on, use dev cloud API environment
DEV_API = bool(int(os.environ.get('MOD_DEV_API', False)))

DESKTOP = bool(int(os.environ.get('MOD_DESKTOP', False)))
LOG = int(os.environ.get('MOD_LOG', 0))

API_KEY = os.environ.pop('MOD_API_KEY', None)
DEVICE_KEY = os.environ.pop('MOD_DEVICE_KEY', None)
DEVICE_TAG = os.environ.pop('MOD_DEVICE_TAG', None)
DEVICE_UID = os.environ.pop('MOD_DEVICE_UID', None)
IMAGE_VERSION_PATH = os.environ.pop('MOD_IMAGE_VERSION_PATH', '/etc/mod-release/release')
HARDWARE_DESC_FILE = os.environ.pop('MOD_HARDWARE_DESC_FILE', '/etc/mod-hardware-descriptor.json')

if os.path.isfile(IMAGE_VERSION_PATH):
    with open(IMAGE_VERSION_PATH, 'r') as fh:
        IMAGE_VERSION = fh.read().strip() or None
else:
    IMAGE_VERSION = None

DATA_DIR = os.environ.get('MOD_DATA_DIR', os.path.expanduser('~/data'))
CACHE_DIR = os.path.join(DATA_DIR, '.cache')
USER_FILES_DIR = os.environ.get('MOD_USER_FILES_DIR', '/data/user-files')
KEYS_PATH = os.environ.get('MOD_KEYS_PATH', join(DATA_DIR, 'keys'))
FAVORITES_JSON_FILE = os.environ.get('MOD_FAVORITES_JSON', join(DATA_DIR, 'favorites.json'))
LAST_STATE_JSON_FILE = os.environ.get('MOD_LAST_STATE_JSON', join(DATA_DIR, 'last.json'))
PREFERENCES_JSON_FILE = os.environ.get('MOD_PREFERENCES_JSON', join(DATA_DIR, 'prefs.json'))
USER_ID_JSON_FILE = os.environ.get('MOD_USER_ID_JSON', join(DATA_DIR, 'user-id.json'))

USER_BANKS_JSON_FILE = os.environ.get('MOD_USER_BANKS_JSON', join(DATA_DIR, 'banks.json'))
FACTORY_BANKS_JSON_FILE = os.environ.get('MOD_FACTORY_BANKS_JSON', '/usr/share/mod/banks.json')

# It's mandatory KEYS_PATH ends with / and is in MOD_KEYS_PATH,
# so utils_lilv.so can properly access it
if not KEYS_PATH.endswith('/'):
    KEYS_PATH += '/'
os.environ['MOD_KEYS_PATH'] = KEYS_PATH

DOWNLOAD_TMP_DIR = os.environ.get('MOD_DOWNLOAD_TMP_DIR', '/tmp/mod-ui')
PEDALBOARD_TMP_DIR = os.environ.get('MOD_PEDALBOARD_TMP_DIR', join(DATA_DIR, 'pedalboard-tmp-data'))

LV2_PLUGIN_DIR = os.environ.get('MOD_USER_PLUGINS_DIR', os.path.expanduser("~/.lv2"))
LV2_PEDALBOARDS_DIR = os.environ.get('MOD_USER_PEDALBOARDS_DIR', os.path.expanduser("~/.pedalboards"))
LV2_FACTORY_PEDALBOARDS_DIR = os.environ.get('MOD_FACTORY_PEDALBOARDS_DIR', "/usr/share/mod/pedalboards")

HMI_BAUD_RATE = os.environ.get('MOD_HMI_BAUD_RATE', 10000000)
HMI_SERIAL_PORT = os.environ.get('MOD_HMI_SERIAL_PORT', "/dev/ttyUSB0")
HMI_TIMEOUT = int(os.environ.get('MOD_HMI_TIMEOUT', 0))

MODEL_CPU = os.environ.get('MOD_MODEL_CPU', None)
MODEL_TYPE = os.environ.get('MOD_MODEL_TYPE', None)

DEVICE_WEBSERVER_PORT = int(os.environ.get('MOD_DEVICE_WEBSERVER_PORT', 80))
DEVICE_HOST_PORT = int(os.environ.get('MOD_DEVICE_HOST_PORT', 5555))

HTML_DIR = os.environ.get('MOD_HTML_DIR', join(sys.prefix, 'share/mod/html/'))
DEFAULT_PEDALBOARD_COPY = os.environ.pop('MOD_DEFAULT_PEDALBOARD', join(sys.prefix, 'share/mod/default.pedalboard'))
DEFAULT_PEDALBOARD = join(LV2_PEDALBOARDS_DIR, "default.pedalboard")

DEFAULT_ICON_TEMPLATE = join(HTML_DIR, 'resources/templates/pedal-default.html')
DEFAULT_SETTINGS_TEMPLATE = join(HTML_DIR, 'resources/settings.html')
DEFAULT_ICON_IMAGE = {
    'thumbnail': join(HTML_DIR, 'resources/pedals/default-thumbnail.png'),
    'screenshot': join(HTML_DIR, 'resources/pedals/default-screenshot.png')
}

# Cloud API addresses
CLOUD_HTTP_ADDRESS = os.environ.pop('MOD_CLOUD_HTTP_ADDRESS', "https://api.mod.audio/v2")
CLOUD_LABS_HTTP_ADDRESS = os.environ.pop('MOD_CLOUD_LABS_HTTP_ADDRESS', "https://api-labs.mod.audio/v2")
PLUGINS_HTTP_ADDRESS = os.environ.pop('MOD_PLUGINS_HTTP_ADDRESS', "https://pedalboards.mod.audio/plugins")
PEDALBOARDS_HTTP_ADDRESS = os.environ.pop('MOD_PEDALBOARDS_HTTP_ADDRESS', "https://pedalboards.mod.audio")
PEDALBOARDS_LABS_HTTP_ADDRESS = os.environ.pop('MOD_PEDALBOARDS_LABS_HTTP_ADDRESS', "https://pedalboards-labs.mod.audio")
CONTROLCHAIN_HTTP_ADDRESS = os.environ.pop('MOD_CONTROLCHAIN_HTTP_ADDRESS',
                                           "https://download.mod.audio/releases/cc-firmware/v3")

MIDI_BEAT_CLOCK_SENDER_URI = "urn:mod:mclk"
MIDI_BEAT_CLOCK_SENDER_INSTANCE_ID = 9993
MIDI_BEAT_CLOCK_SENDER_OUTPUT_PORT = "mclk" # This is the LV2 symbol of the plug-ins OutputPort

TUNER = os.environ.get('MOD_TUNER_PLUGIN', "gxtuner")
TUNER_INSTANCE_ID = 9994

if TUNER == "tuna":
    TUNER_URI = "urn:mod:tuna"
    TUNER_INPUT_PORT = "in"
    TUNER_MONITOR_PORT = "freq_out"
else:
    TUNER_URI = "urn:mod:gxtuner"
    TUNER_INPUT_PORT = "in"
    TUNER_MONITOR_PORT = "FREQ"

PEDALBOARD_INSTANCE = "/pedalboard"
PEDALBOARD_INSTANCE_ID = 9995
PEDALBOARD_URI = "urn:mod:pedalboard"

UNTITLED_PEDALBOARD_NAME="Untitled Pedalboard"
DEFAULT_SNAPSHOT_NAME="Default"

# Pedalboard minimap, rendered by the HMI from a server-side display list.
# The view is the HMI's own 128x64 panel; the scene is larger and pans under it.
MINIMAP_MAX_WIDTH = int(os.environ.get('MOD_MINIMAP_MAX_WIDTH', 1024))
MINIMAP_MAX_HEIGHT = int(os.environ.get('MOD_MINIMAP_MAX_HEIGHT', 512))
MINIMAP_VIEW_WIDTH = int(os.environ.get('MOD_MINIMAP_VIEW_WIDTH', 128))
MINIMAP_VIEW_HEIGHT = int(os.environ.get('MOD_MINIMAP_VIEW_HEIGHT', 64))

# The rectangle the builder screen actually gives the graph, once its title bar and
# footer have taken their share -- mirrors MINIMAP_VIEW_* in app/src/mode_builder.c.
# Distinct from the panel above, which is what the reference renderer draws: the window
# is chosen for what the device will really show, and modelling it as the whole panel
# makes the window twice as tall as it needs to be.
MINIMAP_HMI_VIEW_WIDTH = int(os.environ.get('MOD_MINIMAP_HMI_VIEW_WIDTH', 124))
MINIMAP_HMI_VIEW_HEIGHT = int(os.environ.get('MOD_MINIMAP_HMI_VIEW_HEIGHT', 43))
MINIMAP_LAYERS = os.environ.get('MOD_MINIMAP_LAYERS', 'audio,midi,cv')

# How the graph is drawn. 'detail' is port accurate: every cable and every stub, with
# boxes tall enough to hold them. 'compact' answers the smaller question of what is
# wired to what -- one line per pair of boxes, every box the same size -- which fits
# far more of a pedalboard on a 128px panel.
MINIMAP_MODE = os.environ.get('MOD_MINIMAP_MODE', 'compact')
# must stay under the firmware's WEBGUI_COMM_RX_BUFF_SIZE (4096)
MINIMAP_MAX_MSG = int(os.environ.get('MOD_MINIMAP_MAX_MSG', 3900))
# plugins per window; connections are never windowed, they follow the plugins
MINIMAP_WIN_PLUGINS = int(os.environ.get('MOD_MINIMAP_WIN_PLUGINS', 28))

# Mirror the fixed arrays in the firmware's app/inc/minimap.h. A display list with more
# records than these holds is silently truncated on the device -- boxes and cables simply
# go missing -- so the window shrinks until it fits, exactly as it does for MINIMAP_MAX_MSG.
MINIMAP_MAX_NODES = int(os.environ.get('MOD_MINIMAP_MAX_NODES', 28))
MINIMAP_MAX_PORTS = int(os.environ.get('MOD_MINIMAP_MAX_PORTS', 72))
MINIMAP_MAX_EDGES = int(os.environ.get('MOD_MINIMAP_MAX_EDGES', 48))

# Mirrors BM_MAX_CONNECTIONS in the firmware's app/src/mode_builder.c. The connection and
# target menus are capped there, and a longer list would be truncated on arrival with
# nothing to say so -- the last few boxes would simply be unreachable.
MINIMAP_MAX_MENU = int(os.environ.get('MOD_MINIMAP_MAX_MENU', 48))

# Mirrors BM_MAX_PAIRS / BM_MAX_ROW_PAIRS in mode_builder_connmanager.c. A menu row stands
# for every cable between the same two boxes, and these bound the port names sent along
# with it for the strip at the foot of the list. The whole menu shares the first budget,
# so a box with an improbable number of cables loses the names off its last rows rather
# than overrunning the device's 4kB receive buffer.
MINIMAP_MAX_PAIRS = int(os.environ.get('MOD_MINIMAP_MAX_PAIRS', 48))
MINIMAP_MAX_ROW_PAIRS = int(os.environ.get('MOD_MINIMAP_MAX_ROW_PAIRS', 4))

# How many sub-pages the panel's knobs come round in. The hardware descriptor only says
# whether there are any (`hmi_subpages`), not how many, and the firmware knows the number
# without being told -- so it is written down here too, and the two have to agree.
MINIMAP_HMI_SUBPAGES = int(os.environ.get('MOD_MINIMAP_HMI_SUBPAGES', 3))

CAPTURE_PATH='/tmp/capture.ogg'
PLAYBACK_PATH='/tmp/playback.ogg'

UPDATE_MOD_OS_FILE='/data/{}'.format(os.environ.get('MOD_UPDATE_MOD_OS_FILE', 'modduo.tar').replace('*','cloud'))
UPDATE_MOD_OS_HERLPER_FILE='/data/boot-restore'
UPDATE_CC_FIRMWARE_FILE='/tmp/cc-firmware.bin'
