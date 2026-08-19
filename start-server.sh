#!/bin/sh
export MOD_DATA_DIR=$(pwd)/../mod-home/
export MOD_USER_FILES_DIR=$(pwd)/../user-files/
export LV2_PATH=$(pwd)/../plugins/lv2/

python server.py
