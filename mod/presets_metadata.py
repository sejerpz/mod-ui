#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

import os
import json
import logging
from tornado import gen
from mod import (
  safe_json_load,
  TextFileFlusher
)


class PresetsMetadata(object):
    def __init__(self):
        self.waiting_for_cc = False
        self.waiting_for_cc_cbs = []

    def _dont_wait_for_cc(self):
        self.waiting_for_cc = False
        for cb in self.waiting_for_cc_cbs:
            cb()
        self.waiting_for_cc_cbs = []

    @gen.coroutine
    def load(self, bundlepath: str, instances, abort_catcher):
        """
        Load presets metadata from bundlepath.
        Metadata contains pedalboard information about presets selection for addressing, etc...
        """

        self.data = dict()
        # Check if pedalboard contains presets metadata first
        datafile = os.path.join(bundlepath, "presets-metadata.json")
        if not os.path.exists(datafile):
            self._dont_wait_for_cc()
            return

        # Load presets meta
        self.data = safe_json_load(datafile, dict)

        print("Loaded presets metadata:", self.data)
        # Load all plugin preset metadata possible
        for plugin_uri, preset in self.data.items():
            if abort_catcher is not None and abort_catcher.get('abort', False):
                print("WARNING: Abort triggered during presets-metadata.load requests, caller:", abort_catcher['caller'])
                return

        return

    def save(self, bundlepath):
        """Save presets metadata to bundlepath."""

        print("Saving presets metadata to:", bundlepath)
        with TextFileFlusher(os.path.join(bundlepath, "presets-metadata.json")) as fh:
            json.dump(self.data, fh, indent=4)

        return

    def get(self, instance: str, preset_uri: str):
        """Get metadata for a given preset URI."""

        metadata = None
        instance_meta = self.data.get(instance, None)

        if instance_meta is not None:
            metadata = instance_meta.get(preset_uri, None)

        logging.debug("Getting preset metadata instance_id %s, preset_uri %s: %s", instance, preset_uri, metadata)
        if (metadata is None):
            # if no metadata is found for the preset, return a default values
            metadata = {
                'enabled': True
            }

        return metadata

    def set(self, instance: str, preset_uri: str, metadata: dict, callback):
        """Set metadata for a given plugin instance, preset URI."""
        
        logging.debug("Setting preset metadata instance_id %s, preset_uri %s: %s", instance, preset_uri, metadata)
        instance_metadata = self.data.get(instance, None)
        if instance_metadata is None:
            instance_metadata = dict()
            self.data[instance] = instance_metadata
 
        instance_metadata[preset_uri] = metadata

        if (callback is not None):
            callback(True)
            
        return metadata
