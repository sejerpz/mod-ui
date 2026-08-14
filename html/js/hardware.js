// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Special URI for non-addressed controls
var kNullAddressURI = "null"

// Special URIs for midi-learn
var kMidiLearnURI = "/midi-learn"
var kMidiUnlearnURI = "/midi-unlearn"
var kMidiCustomPrefixURI = "/midi-custom_" // to show current one, ignored on save

// URI for BPM sync (for non-addressed control ports)
var kBpmURI ="/bpm"

// Grouped options
var deviceOption = "/hmi"
var ccOption = "/cc"
var cvOption = "/cv"

// Port types supported by cv addressing
var cvModes = ":float:integer:bypass:toggled:"

// use pitchbend as midi cc, with an invalid MIDI controller number
var MIDI_PITCHBEND_AS_CC = 131

function create_midi_cc_uri (channel, controller) {
    if (controller == MIDI_PITCHBEND_AS_CC) {
        return sprintf("%sCh.%d_Pbend", kMidiCustomPrefixURI, channel+1)
    }
    return sprintf("%sCh.%d_CC#%d", kMidiCustomPrefixURI, channel+1, controller)
}

function startsWith (value, pattern) {
    return value != null && value.indexOf(pattern) === 0;
};

function is_control_chain_uri (uri) {
  if (startsWith(uri, deviceOption)) {
    return false;
  }
  if (uri == kMidiLearnURI || startsWith(uri, kMidiCustomPrefixURI)) {
    return false;
  }
  if (isCvUri(uri)) {
    return false;
  }
  return true;
}

function isCvUri (uri) {
  if (startsWith(uri, cvOption)) {
    return true;
  }
  return false;
}

function isHwCvUri (uri) {
  if (startsWith(uri, cvOption + '/graph/cv_')) {
    return true;
  }
  return false;
}

// Units supported for tap tempo (lowercase)
var kTapTempoUnits = ['bpm']

function HardwareManager(options) {
    var self = this

    options = $.extend({
        // This is the function that will actually make the addressing
        address: function (instanceAndSymbol, addressing, callback) { callback(true) },

        // Callback to enable or disable a control in GUI
        setEnabled: function (instance, portSymbol, enabled, feedback, momentaryMode) {},

        // Renders the address html template
        renderForm: function (instance, port) {},

        // Running as mod-app
        isApp: function () { return false },

        // used to save config on the server side
        saveConfigValue: function( key, value, callback ) { },
    }, options)

    this.beatsPerMinutePort = {
      ranges: { // XXX would be good to have a centralized place for this data, currently it's also in transport.js and others
          minimum: 20.0,
          maximum: 280.0
      },
      value: null
    }

    this.cvOutputPorts = []
    this.ccActuators = []

    this.setBeatsPerMinuteValue = function (bpm) {
      if (self.beatsPerMinutePort.value === bpm) {
          return
      }
      self.beatsPerMinutePort.value = bpm
    }

    this.reset = function () {
        var addressingsByActuator = $.extend({}, self.addressingsByActuator)
        var cvOutputPorts = self.cvOutputPorts.slice()

        /* All adressings indexed by actuator
            key  : "/actuator-uri"
            value: list("/instance/symbol")
         */
         self.addressingsByActuator = {}
         self.cvOutputPorts = []

         if (cvOutputPorts) {
           for (var i = 0; i < cvOutputPorts.length; i++) {
             // if hw cv port, keep it
             if (isHwCvUri(cvOutputPorts[i].uri)) {
               self.cvOutputPorts.push(cvOutputPorts[i])
             }
           }
         }

        if (addressingsByActuator) {
          for (var act in addressingsByActuator) {
            if (isCvUri(act) && cvOutputPorts.find(function (port) { return port.uri === act })) {
              self.addressingsByActuator[act] = []
            }
          }
        }

       /* All addressings indexed by instance + port symbol
           key  : "/instance/symbol"
           value: "/actuator-uri"
        */
        self.addressingsByPortSymbol = {}

       /* Saved addressing data
           key  : "/instance/symbol"
           value: dict(AddressData)
        */
        self.addressingsData = {}
        // Initializes actuators
        if (HARDWARE_PROFILE) {
            var uri
            for (var i in HARDWARE_PROFILE) {
                uri = HARDWARE_PROFILE[i].uri
                self.addressingsByActuator[uri] = []
            }
        }
        self.addressingsByActuator[kMidiLearnURI] = []
        self.addressingsByActuator[kBpmURI] = []
    }

    this.reset()

    // Get all addressing types that can be used for a port
    // Most of these are 1:1 match to LV2 hints, but we have extra details.
    this.availableAddressingTypes = function (port, tempo) {
        if (tempo) {
            return ["enumeration"]
        }

        var available  = []

        if (port) {
          var properties = port.properties

          // prevent some properties from going together
          if (properties.indexOf("trigger") >= 0) {
              available.push("trigger")
          } else if (properties.indexOf("enumeration") >= 0) {
              available.push("enumeration")
          } else if (properties.indexOf("toggled") >= 0) {
              available.push("toggled")
          } else if (properties.indexOf("integer") >= 0) {
              available.push("integer")
          } else {
              available.push("float")
          }

          if (properties.indexOf("logarithmic") >= 0)
              available.push("logarithmic")

          if (port.symbol === ":bpm" && properties.indexOf("tapTempo") >= 0 && kTapTempoUnits.indexOf(port.units.symbol.toLowerCase()) >= 0)
              available.push("taptempo")

          if (port.scalePoints.length >= 2)
              available.push("scalepoints")
          if (port.symbol == ":bypass")
              available.push("bypass")
        } else {
          // if port is null, we are in overview mode, show all actuators
          available.push("integer")
          available.push("logarithmic")
          available.push("taptempo")
          available.push("scalepoints")
          available.push("enumeration")
          available.push("bypass")
        }

        return available
    }

    this.availableActuatorsWithModes = function (list, types) {
      var available = {}
      if (list) {
        for (var i in list) {
            actuator = list[i]
            modes    = actuator.modes

            // usedAddressings = self.addressingsByActuator[actuator.uri]
            // if (ADDRESSING_PAGES == 0 && usedAddressings.length >= actuator.max_assigns && usedAddressings.indexOf(key) < 0) {
            //     continue
            // }

            if (
                (types.indexOf("integer"    ) >= 0 && modes.search(":integer:"    ) >= 0) ||
                (types.indexOf("float"      ) >= 0 && modes.search(":float:"      ) >= 0) ||
                (types.indexOf("enumeration") >= 0 && modes.search(":enumeration:") >= 0) ||
                (types.indexOf("logarithmic") >= 0 && modes.search(":logarithmic:") >= 0) ||
                (types.indexOf("toggled"    ) >= 0 && modes.search(":toggled:"    ) >= 0) ||
                (types.indexOf("trigger"    ) >= 0 && modes.search(":trigger:"    ) >= 0) ||
                (types.indexOf("taptempo"   ) >= 0 && modes.search(":taptempo:"   ) >= 0) ||
                (types.indexOf("scalepoints") >= 0 && modes.search(":scalepoints:") >= 0) ||
                (types.indexOf("bypass"     ) >= 0 && modes.search(":bypass:"     ) >= 0)
              )
            {
                available[actuator.uri] = actuator
            }
        }
      }
      return available
    }

    this.isCvAvailable = function (port) {
      if (!port)
        return false

      var defaultTypes = self.availableAddressingTypes(port, false)
      var available = self.availableActuatorsWithModes([{ uri: cvOption, modes: cvModes }], defaultTypes)
      return available.hasOwnProperty(cvOption)
    }

    // Gets a list of available actuators for a port
    this.availableActuators = function (instance, port, tempo) {
        var defaultTypes = self.availableAddressingTypes(port, false)
        var types = tempo ? self.availableAddressingTypes(port, tempo) : defaultTypes

        var available = self.availableActuatorsWithModes(HARDWARE_PROFILE, types)

        // midi-learn is always available, except for enumeration or when port is null: overview mode
        if (defaultTypes.indexOf("enumeration") < 0 || !port || port.scalePoints.length == 2)
        {
            available[kMidiLearnURI] = {
                uri  : kMidiLearnURI,
                name : "MIDI Learn...",
                modes: ":float:trigger:bypass:integer:toggled:",
                steps: [],
                max_assigns: 99
            }
        }

        available = $.extend(self.availableActuatorsWithModes(self.cvOutputPorts, defaultTypes), available)

        return available
    }

    this.buildDividerOptions = function (select, port, curDividers) {
        select.children().remove()

        var filteredDividers = getDividerOptions(port, self.beatsPerMinutePort.ranges.minimum, self.beatsPerMinutePort.ranges.maximum)

        // And build html select options
        for (i = 0; i < filteredDividers.length; i++) {
          $('<option>').attr('value', filteredDividers[i].value).html(filteredDividers[i].label).appendTo(select)
        }

        // Select previously saved divider or set first divider as default
        if (filteredDividers.length > 0) {
          var def = (curDividers !== null && curDividers !== undefined) ? curDividers : filteredDividers[0].value
          select.val(def)
        }

        return filteredDividers
    }

    this.buildSensitivityOptions = function (select, port, actuatorSteps, curStep) {
        select.children().remove()

        if (!port)
          return

        if (port.properties.indexOf("enumeration") >= 0 ||
            port.properties.indexOf("integer") >= 0 ||
            port.properties.indexOf("toggled") >= 0 ||
            port.properties.indexOf("trigger") >= 0)
        {
            var value
            if (port.properties.indexOf("enumeration") >= 0) {
                value = port.scalePoints.length - 1
            } else if (port.properties.indexOf("integer") >= 0) {
                value = port.ranges.maximum - port.ranges.minimum
            } else {
                value = 1
            }
            $('<option value='+value+'>').appendTo(select)
            select.val(value)
            select.hide()
            if (port.symbol != ":bypass" && port.symbol != ":presets") {
                select.parent().parent().hide()
            }
            return
        }

        var def, soptions = {}

        switch ((actuatorSteps ? actuatorSteps.length : null))
        {
        case 1:
            def = actuatorSteps[0]
            soptions[def] = 'Default'
            break
        case 2:
            def = actuatorSteps[0]
            soptions[actuatorSteps[0]] = 'Medium'
            soptions[actuatorSteps[1]] = 'High'
            break
        case 3:
            def = actuatorSteps[1]
            soptions[actuatorSteps[0]] = 'Low'
            soptions[actuatorSteps[1]] = 'Medium'
            soptions[actuatorSteps[2]] = 'High'
            break
        default:
            def = 33
            soptions = {
                17: 'Low',
                33: 'Medium',
                65: 'High',
            }
            break
        }

        if (port.rangeSteps) {
            def = port.rangeSteps
            soptions[def] = 'Default'
        }

        var steps, label, keys = Object.keys(soptions).sort()
        for (var i in keys) {
            steps  = keys[i]
            label  = soptions[steps]
            label += ' (' + steps + ' steps)'
            $('<option>').attr('value', steps).html(label).appendTo(select)
        }

        select.val(curStep != null ? curStep : def)

        if (keys.length === 1) {
            select.parent().parent().hide()
        }
    }

    this.disableMinMaxSteps = function (form, disabled) {
      form.find('select[name=steps]').prop('disabled', disabled)
      form.find('input[name=min]').prop('disabled', disabled)
      form.find('input[name=max]').prop('disabled', disabled)
    }

    this.portSupportsSensitivity = function(port) {
      if (!port)
        return false;
      if (port.properties.indexOf("integer") >= 0)
        return false;
      if (port.properties.indexOf("toggled") >= 0)
        return false;
      if (port.properties.indexOf("trigger") >= 0)
        return false;
      if (port.symbol == ":bypass")
        return false;
      if (port.symbol == ":presets")
        return false;
      return true;
    }

    this.toggleAdvancedItemsVisibility = function (port,
                                                   sensitivity, ledColourMode, momentarySwMode,
                                                   currentActuator, curStep) {
      if (currentActuator && currentActuator.steps.length !== 0 && this.portSupportsSensitivity(port)) {
        sensitivity.removeClass('disabled').parent().parent().show()
      } else {
        sensitivity.addClass('disabled').parent().parent().hide()
      }

      if (currentActuator && currentActuator.modes.indexOf(":colouredlist:") >= 0 &&
          port &&
          port.properties.indexOf("enumeration") >= 0)
      {
        ledColourMode.removeClass('disabled').parent().parent().show()
      }
      else
      {
        ledColourMode.addClass('disabled').parent().parent().hide()
      }

      if (currentActuator && currentActuator.modes.indexOf(":momentarytoggle:") >= 0 &&
          port &&
          port.properties.indexOf("enumeration") < 0 &&
          port.properties.indexOf("tapTempo") < 0 &&
          port.properties.indexOf("trigger") < 0)
      {
        momentarySwMode.removeClass('disabled').parent().parent().show()
      }
      else
      {
        momentarySwMode.addClass('disabled').parent().parent().hide()
      }

      self.buildSensitivityOptions(sensitivity,
                                   port,
                                   currentActuator ? currentActuator.steps : null,
                                   curStep)
    }

    this.getMidiDisplayLabel = function(currentAddressing) {
      return "MIDI " + currentAddressing.uri.replace(kMidiCustomPrefixURI,"").replace(/_/g," ");
    }

    // Show dynamic field content based on selected type of addressing
    this.showDynamicField = function (is_overview, form, typeInputVal, currentAddressing, port, cvUri, firstOpen) {
      // Hide all then show the relevant content
      form.find('.dynamic-field').hide()
      // Hide led-color and momentary modes, only usable for a few selections
      // These are enabled by various event triggers below as needed
      form.find('select[name=led-color-mode]').addClass('disabled').parent().parent().hide()
      form.find('select[name=momentary-sw-mode]').addClass('disabled').parent().parent().hide()

      if (typeInputVal === kMidiLearnURI)
      {
        if (is_overview) {
          form.find('.midi-table').show()
        } else {
          if (currentAddressing && currentAddressing.uri && currentAddressing.uri.lastIndexOf(kMidiCustomPrefixURI, 0) === 0) {
            form.find('.midi-learn-hint').hide()
            var midiCustomLabel = self.getMidiDisplayLabel(currentAddressing);
            form.find('.midi-custom-uri').text(midiCustomLabel)
            form.find('.midi-learn-custom').show()
          } else {
            form.find('.midi-learn-hint').show()
          }
        }
      }
      else if (typeInputVal === deviceOption)
      {
        form.find('.device-table').find('.selected').click()
        form.find('.device-table').show()
      }
      else if (typeInputVal === ccOption)
      {
        if (is_overview) {
          form.find('.cc-table').show()
        } else {

          var ccActuatorSelect = form.find('select[name=cc-actuator]')
          if (ccActuatorSelect.children('option').length) {
            ccActuatorSelect.change()
            form.find('.cc-select').show()
          } else if (self.hasControlChainDevice()) {
            form.find('.cc-in-use').show()
          } else {
            form.find('.no-cc').show()
          }
        }
      }
      else if (typeInputVal === cvOption)
      {
        if (self.cvOutputPorts.length) {
          if (is_overview) {
            form.find('.cv-table').show()
            form.find('.cv-select').hide()
          } else {
            form.find('.cv-select').show()
          }
        } else {
          form.find('.no-cv').show()
        }
      }

      // Disabled/Enable save button
      if (currentAddressing && currentAddressing.uri) {
        if (typeInputVal === ccOption && !self.hasControlChainDevice() ||
            (typeInputVal === cvOption && !self.cvOutputPorts.length)) {
          form.find('.js-save').addClass('disabled')
        } else {
          form.find('.js-save').removeClass('disabled')
        }
      } else {
        if ((!form.find('input[name=tempo]').prop("checked") && typeInputVal === kNullAddressURI) ||
            (typeInputVal === ccOption && !self.hasControlChainDevice()) ||
            (typeInputVal === cvOption && !self.cvOutputPorts.length)) {
          form.find('.js-save').addClass('disabled')
        } else {
          form.find('.js-save').removeClass('disabled')
        }
      }

      // Hide/show extended specific content
      if (typeInputVal === kNullAddressURI ||
          typeInputVal === kMidiLearnURI || typeInputVal.lastIndexOf(kMidiCustomPrefixURI, 0) === 0 ||
          (typeInputVal === ccOption && !self.hasControlChainDevice()) ||
          typeInputVal === cvOption ||
          ! this.portSupportsSensitivity(port))
      {
        form.find('.sensitivity').css({ display: "none" })
        self.disableMinMaxSteps(form, false)
      }
      else
      {
        form.find('.sensitivity').css({ display: "block" })
      }

      if (typeInputVal === kMidiLearnURI || typeInputVal.lastIndexOf(kMidiCustomPrefixURI, 0) === 0 || typeInputVal === ccOption || typeInputVal === cvOption)
      {
        form.find('.tempo').css({ display: "none" })
      }
      else if (hasTempoRelatedDynamicScalePoints(port))
      {
        form.find('.tempo').css({ display: "block" })
        if (form.find('input[name=tempo]').prop("checked")) {
          self.disableMinMaxSteps(form, true)
        }
      }

      // Hide/show cv operational mode for everything except CV plugin ports
      if (typeInputVal !== cvOption || isHwCvUri(cvUri)) {
        form.find('.cv-op-mode').css({ display: "none" })
      } else {
        form.find('.cv-op-mode').css({ display: "block" })
      }

      // Set unipolar mode based on default cv port ranges or current addressing
      if (typeInputVal === cvOption) {
        var cvPort = self.cvOutputPorts.find(function (port) { return port.uri === cvUri })
        if (cvPort) {
          var operationalMode = cvPort.defaultOperationalMode
          if (firstOpen && currentAddressing && currentAddressing.uri &&
              isCvUri(currentAddressing.uri) && currentAddressing.operationalMode)
          {
            operationalMode = currentAddressing.operationalMode
          }
          form.find('select[name=cv-op-mode]').val(operationalMode)
        }
      }
    }

    this.parseAddressing = function(addressing, addressingData, model) {
      // found
      const parts = addressing.split('/')
      let result = {
        pluginId: parts.slice(0, -1).join('/'),
        portSymbol: parts[parts.length - 1],
        addressingData: addressingData,
        addressing: addressing,
        plugin: null,
        port: null,
        cv: null,
        cc: null,
      }

      if (model && model.plugins) {
        result.plugin = model.plugins[result.pluginId]?.data('gui')
        result.port = result.plugin?.controls ? result.plugin?.controls[result.portSymbol] : null
      }

      return result
    }

    // this function search the addressing by page, subpage, actuatorUri
    // the model parameter is optional, if not passed resul.plugi and result. port will be not set
    // return null if not found or {pluginId, portSymbol: string, addressing: AddressingData, plugin (optional): Plugin,  port (optional): Port}
    this.findAddressing = function(actuatorUri, page, subpage, model) {
      const addressings = self.addressingsByActuator[actuatorUri]
      let result = null

      if (addressings?.length > 0) {
        for(const addressing of addressings) {
          const addressingData = self.addressingsData[addressing] 
          if (addressingData && addressingData.page == page && addressingData.subpage == subpage) {
            result = self.parseAddressing(addressing, addressingData, model)
            break
          }
        }
      }

      return result
    }

    self.onSelectedAddressingChange = function(actuatorUri, model, addressing) {
      if (model.is_overview) {
        model.port = addressing?.port ?? null
        model.addressing = addressing?.addressingData ?? {}
        model.plugin = addressing?.plugin ?? null
        model.instance = addressing?.pluginId ?? ""
        model.plugin_label = addressing?.plugin?.effect?.name ?? ""
        self.updateView(model)
      }

      self.toggleAdvancedItemsVisibility(model.port,
                                model.sensitivity, model.ledColourMode, model.momentarySwMode,
                                model.actuators[actuatorUri],
                                model.addressing?.uri === actuatorUri ? model.addressing.steps : null)
    }

    this.buildDeviceTable = function (model, currentAddressing) {
      let deviceTable = model.deviceTable
      let actuators = model.actuators
      let hmiPageInput = model.hmiPageInput
      let hmiSubPageInput = model.hmiSubPageInput
      let hmiUriInput   = model.hmiUriInput
      // let sensitivity = model.sensitivity
      // let ledColourMode = model.ledColourMode
      // let momentarySwMode = model.momentarySwMode
      let port = model.port
      var table = $('<table/>').addClass('hmi-table')
      var row, cell, ctable, uri, uriAddressings, usedAddressings, addressing
      var actuator, actuatorName, actuatorSubPages, groupActuator, groupAddressings, lastGroupName, subpageTables = {}
      const draggableOptions = { disabled: !model.is_overview, cursor: "move", opacity: 0.8, helper: "clone" }

      if (ADDRESSING_PAGES > 0)
      {
        // build header row
        var headerRow = $('<tr/>')
        for (var i = 1; i <= ADDRESSING_PAGES; i++) {
          headerRow.append($('<th>Page '+i+'</th>'))
        }
        table.append(headerRow)

        for (var actuatorUri in actuators) {
          if (!startsWith(actuatorUri, deviceOption)) {
            continue
          }
          actuator = actuators[actuatorUri]
          actuatorSubPages = actuator.subpages || [null]
          usedAddressings = self.addressingsByActuator[actuatorUri]

          // pre-create groups for subpages
          if (actuator.subpages) {
            for (var i in actuator.subpages) {
              lastGroupName = actuator.subpages[i]
              if (!subpageTables[lastGroupName]) {
                  deviceTable.append(table)
                  deviceTable.append($('<div class="group-strike">'+ lastGroupName +'</div>'))
                  table = subpageTables[lastGroupName] = $('<table/>').addClass('hmi-table')
              } else {
                  table = subpageTables[lastGroupName]
              }
            }
            ctable = null
            lastGroupName = null

          // actuator belongs to a new group (compared to last one)
          } else if (actuator.group && actuator.group != lastGroupName) {
              deviceTable.append(table)
              deviceTable.append($('<div class="group-strike">'+ actuator.group +'</div>'))
              ctable = table = $('<table/>').addClass('hmi-table')
              lastGroupName = actuator.group

          // there was a group before, but not anymore, so create a "no-group" group
          } else if (lastGroupName && !actuator.group) {
              deviceTable.append(table)
              deviceTable.append($('<div class="group-strike">No Group</div>'))
              ctable = table = $('<table/>').addClass('hmi-table')
              lastGroupName = null

          // no groups ever in use, just act normal
          } else {
              ctable = table
          }

          for (var actSubPage = 0; actSubPage < actuatorSubPages.length; actSubPage++) {
            row = $('<tr/>')
            if (actuator.subpages) {
                ctable = subpageTables[actuatorSubPages[actSubPage]]
            }

            // add the columns
            for (var addrPage = 0; addrPage < ADDRESSING_PAGES; addrPage++) {
              // define a fixed width avoid table shrink on drag & drop
              const col = $("<col style='width: 86px;'/>")
              ctable.append(col)
            }

            for (var addrPage = 0; addrPage < ADDRESSING_PAGES; addrPage++) {
              actuatorName = lastGroupName ? (actuator.gname || actuator.name) : actuator.name
              cell = $('<td data-page="'+ addrPage +'" data-subpage="'+ actSubPage +'" data-uri="'+ actuatorUri +'">'+ actuatorName +'</td>')
              if (currentAddressing &&
                  currentAddressing.uri == actuatorUri &&
                  currentAddressing.page == addrPage &&
                  (currentAddressing.subpage == null || currentAddressing.subpage == actSubPage)) {
                hmiPageInput.val(currentAddressing.page)
                hmiSubPageInput.val(currentAddressing.subpage)
                hmiUriInput.val(currentAddressing.uri)
                cell.addClass('selected')
              } else {
                // Only allow actuator groups to be used when all their "child" actuators are not in use on current page
                if (actuator.actuator_group) {
                  for (var i = 0; i < actuator.actuator_group.length; i++) {
                    uri = actuator.actuator_group[i]
                    uriAddressings = self.addressingsByActuator[uri]
                    for (var j in uriAddressings) {
                      instance = uriAddressings[j]
                      addressing = self.addressingsData[instance]
                      if (addressing.page == addrPage) {
                        cell.addClass('disabled')
                      }
                    }
                  }
                }
                // Check if page+uri already assigned, then disable cell
                for (var i in usedAddressings) {
                  instance = usedAddressings[i]
                  addressing = self.addressingsData[instance]
                  if (addressing.page == addrPage &&
                      (addressing.subpage == null || addressing.subpage == actSubPage)) {
                    cell.text(addressing.label)
                    cell.attr('title', addressing.label);
                    // in the overview the buttons assigned are enabled
                    if (!port) {
                      cell.removeClass('disabled')
                      if (model.is_overview) {
                        cell.addClass('binded').draggable(draggableOptions)
                        cell.draggable()
                      }
                    } else {
                      if (model.is_overview) {
                        cell.addClass('binded').draggable(draggableOptions)
                      } else {
                        cell.addClass('disabled')
                      }
                    }
                  }
                }
              }
              row.append(cell)
            }
            ctable.append(row)
          }
        }
      }
      else
      {
        for (var actuatorUri in actuators) {
          if (!startsWith(actuatorUri, deviceOption)) {
            continue
          }
          actuator = actuators[actuatorUri]
          usedAddressings = self.addressingsByActuator[actuatorUri]
          if (actuator.actuator_group && actuator.group && actuator.group != lastGroupName) {
              deviceTable.append(table)
              deviceTable.append($('<div class="group-strike">'+ actuator.group +'</div>'))
              table = $('<table/>').addClass('hmi-table')
              lastGroupName = actuator.group
          }
          row = $('<tr/>')
          cell = $('<td data-uri="'+ actuatorUri +'">'+ actuator.name+'</td>')

          if (currentAddressing && currentAddressing.uri == actuatorUri) {
            hmiUriInput.val(currentAddressing.uri)
            cell.addClass('selected')
          } else {
            // Only allow actuator groups to be used when all their "child" actuators are not in use
            if (actuator.actuator_group) {
              for (i = 0; i < actuator.actuator_group.length; i++) {
                uri = actuator.actuator_group[i]
                uriAddressings = self.addressingsByActuator[uri]
                if (uriAddressings.length) {
                  cell.addClass('disabled')
                }
              }
            }
            if (usedAddressings.length >= actuator.max_assigns) {
              cell.addClass('disabled')
            }
          }

          row.append(cell)
          table.append(row)
        }
      }

      deviceTable.append(table)

      // when addressing an actuator group, all "child" actuators or intersecting actuator groups are no longer
      // available to be addressed to anything else except on different pages
      if (ADDRESSING_PAGES > 0)
      {
        for (var i in HARDWARE_PROFILE) {
          if (HARDWARE_PROFILE[i].actuator_group) {
            groupActuator = HARDWARE_PROFILE[i]
            for (var j in self.addressingsByActuator[groupActuator.uri]) {
              instance = self.addressingsByActuator[groupActuator.uri][j]
              groupAddressings = self.addressingsData[instance]
              for (var k in groupActuator.actuator_group) {
                deviceTable.find('[data-uri="' + groupActuator.actuator_group[k] + '"][data-page="' + groupAddressings.page + '"]').addClass('disabled')
                for (var l in actuators) {
                  if (l !== groupActuator.uri && actuators[l].actuator_group && actuators[l].actuator_group.includes(groupActuator.actuator_group[k])) {
                    deviceTable.find('[data-uri="' + l + '"][data-page="' + groupAddressings.page + '"]').addClass('disabled')
                  }
                }
              }

            }
          }
        }
      }
      else
      {
        for (var i in HARDWARE_PROFILE) {
          if (HARDWARE_PROFILE[i].actuator_group) {
            groupActuator = HARDWARE_PROFILE[i]
            if (self.addressingsByActuator[groupActuator.uri].length) {
              for (var j in groupActuator.actuator_group) {
                deviceTable.find('[data-uri="' + groupActuator.actuator_group[j] + '"]').addClass('disabled')
              }
            }
          }
        }
      }

      function selectAddressing(page, subpage, actuatorUri) {
        // Update hidden inputs value
        hmiPageInput.val(page)
        hmiSubPageInput.val(subpage)
        hmiUriInput.val(actuatorUri)
        let addressing = null
        // need to find the port when in overview mode
        if (model.is_overview) {
          addressing = self.findAddressing(actuatorUri, page, subpage, model)
        }
        self.onSelectedAddressingChange(actuatorUri, model, addressing)

        return model.addressing
      }

      function onActuatorDrop(event, ui) {
          const fromDataUri = ui.draggable.attr('data-uri')
          const fromPage = ui.draggable.attr('data-page')
          const fromSubpage = ui.draggable.attr('data-subpage')
          const toDataUri = $(this).attr('data-uri')
          const toPage = $(this).attr('data-page')
          const toSubpage = $(this).attr('data-subpage')

          // DEBUG: console.log(`${ui.draggable.text()} dropped on ${$(this).text()}: ${fromDataUri}, ${fromPage}, ${fromSubpage} -> ${toDataUri} ${toPage}, ${toSubpage}`)
          // select and move the source
          selectAddressing(fromPage, fromSubpage, fromDataUri)

          // change hidden fields with the destinations and then save
          hmiPageInput.val(toPage)
          hmiSubPageInput.val(toSubpage)
          hmiUriInput.val(toDataUri)
          self.saveCurrentAddressing()

          // update the deviceTable UI
          // Remove 'selected' class to all cells then add it to the drop target one
          deviceTable.find('td').removeClass('selected')
          $(this)
            .addClass('selected')
            .addClass('binded')
            .droppable({
              disabled: true
            })
            .draggable(draggableOptions)

          // swap source value with destination
          const actuator = model.actuators[fromDataUri]
          let text = actuator?.uri ?? fromDataUri

          if (actuator) {
            if (actuator.uri.startsWith('/hmi/footswitch') || actuator.uri.startsWith('/hmi/group')) {
              text = actuator.gname
            } else {
              text = actuator.name
            }

            if (actuator.actuator_group) {
              // group is moving
              actuator.actuator_group.forEach(element => {
                // enable source single switch
                deviceTable
                  .find("td[data-uri='" + element + "'][data-page='" + fromPage + "'][data-subpage='" + fromSubpage + "']")
                  .removeClass('disabled')
                // disable destination single switch
                deviceTable
                  .find("td[data-uri='" + element + "'][data-page='" + toPage + "'][data-subpage='" + toSubpage + "']")
                  .addClass('disabled')
              });
            }
          }
          ui.draggable
            .attr('title', null)
            .text(text)
            .removeClass('binded')
            .draggable({
              disabled: true
            })
            .droppable(dropOptions)
      }

      const dropOptions = {
        drop: onActuatorDrop,
        disabled: !model.is_overview,
        activeClass: "accept-drop",
        accept: function(draggable) {
          const fromActuator = draggable.attr('data-uri')
          const toActuator = $(this).attr('data-uri')

          if ((fromActuator?.length ?? 0) <= 1 || (toActuator?.length ?? 0) <= 1)
            return false

          const fromUri = fromActuator.substring(0, fromActuator.length - 1)
          const fromPage = draggable.attr('data-page')
          const fromSubpage = draggable.attr('data-subpage')
          const fromPortUri = self.findAddressing(fromActuator, fromPage, fromSubpage)?.addressing ?? null
          const toUri = toActuator.substring(0, toActuator.length - 1)
          const toPage = $(this).attr('data-page')
          const toSubpage = $(this).attr('data-subpage')
          const toPortUri = self.findAddressing(toActuator, toPage, toSubpage)?.addressing ?? null
          const isDisabled = $(this).hasClass('disabled')

          let acceptDrop = false
          // global tempo / bpm are still not supported
          if (!fromPortUri || !fromPortUri.startsWith('/pedalboard/')) {
            // the destination is not addressed and
            // (knobX to knobY, footswitchX to footswitchY, groupX to groupY are valid drop target
            // or from footswitch to knob
            // or port is bypass to footswitch)
            acceptDrop = !toPortUri
                        && isDisabled == false
                        && (fromUri == toUri
                        || (fromUri == '/hmi/footswitch' && toUri == '/hmi/knob')
                        || ((fromPortUri?.endsWith(':bypass') ?? false) && toUri == '/hmi/footswitch'))
          }

          return acceptDrop
        }
      }
      deviceTable.find('td').click(function () {
        if ($(this).hasClass('disabled')) {
          return
        }
        var actuatorUri = $(this).attr('data-uri')
        var page = $(this).attr('data-page')
        var subpage = $(this).attr('data-subpage')

        // Remove 'selected' class to all cells then add it to the clicked one
        deviceTable.find('td').removeClass('selected')
        $(this).addClass('selected')

        selectAddressing(page, subpage, actuatorUri)
      })
      .droppable(dropOptions)

      self.toggleAdvancedItemsVisibility(model.port,
                                         model.sensitivity, model.ledColourMode, model.momentarySwMode,
                                         model.actuators[currentAddressing.uri], currentAddressing.steps)
    }

    this.buildMidiTable = function (model, currentAddressing) {
      model.midiTable.empty()

      if (self.addressingsByActuator[kMidiLearnURI]?.length > 0) {
        let table = $('<table/>').addClass('midi-table-overview')
        let bindings = []

        for(let addressing of self.addressingsByActuator[kMidiLearnURI]) {
          let addressingData = self.addressingsData[addressing]
          if (!addressingData)
            continue

          let binding = self.parseAddressing(addressing, addressingData, model)

          binding.pluginLabel = (binding.plugin.label && binding.plugin.label.length > 0) ? binding.plugin.label : binding.plugin.effect.label
          binding.portLabel = binding.port?.name ?? binding.portSymbol,
          binding.midi = self.getMidiDisplayLabel(addressingData)

          bindings.push(binding)
        }

        // order by plugin, port
        bindings.sort((a,b) => {
          let result = a.pluginLabel.localeCompare(b.pluginLabel)

          if (result == 0) {
            result = a.portLabel.localeCompare(b.portLabel)
          }

          if (result == 0) {
            result = a.midi.localeCompare(b.midi)
          }

          return result;
        });

        const header = $('<tr><th>Plugin</th><th>Parameter</th><th>Binding</th></tr>')
        table.append(header)
        let index = 0
        for(let binding of bindings) {
          let row = $('<tr/>')
          let cell = $(`<td><span class="midi-binding-plugin">${binding.pluginLabel}</span></td>`)
          row.append(cell)

          cell = $(`<td><span class="midi-binding-port">${binding.portLabel}</span></td>`)
          row.append(cell)

          cell = $(`<td><span class="midi-binding-controller">${binding.midi}</span></td>`)
          row.append(cell)

          if (index % 2) {
            row.addClass('odd')
          }
          if (binding.addressing && binding.addressing == currentAddressing) {
            row.addClass('selected');
          }

          table.append(row)
          row.click(function() {
            self.onSelectedAddressingChange(binding.addressingData.uri, model, binding)
            table.find('tr').removeClass('selected')
            row.addClass('selected')
          })

          index++
        }
        model.midiTable.append(table)
      } else {
        let empty = $('<div />')

        empty.addClass('no-selection').text('No Midi bindings defined')
        model.midiTable.append(empty)
      }
    }
    this.buildCCTable = function (model, currentAddressing) {
      model.ccTable.empty()
      let bindings = []

      for(const actuator in self.addressingsByActuator) {
        if (!is_control_chain_uri(actuator)) {
          continue
        }

        const addressings = self.addressingsByActuator[actuator]
        if (addressings?.length > 0) {
          for(let addressing of addressings) {
            let addressingData = self.addressingsData[addressing]
            if (!addressingData)
              continue

            const cc = self.ccActuators.find((item) => item.uri == addressingData.uri)
            if (!cc)
              continue

            let binding = self.parseAddressing(addressing, addressingData, model)

            binding.pluginLabel = (binding.plugin.label && binding.plugin.label.length > 0) ? binding.plugin.label : binding.plugin.effect.label
            binding.portLabel = (addressingData.label && addressingData.label.length > 0) ? addressingData.label : (binding.port?.name && binding.port.name.length > 0) ? binding.port.name : binding.portSymbol
            binding.cc = self.ccActuators.find((item) => item.uri == addressingData.uri)

            bindings.push(binding)
          }
        }
      }

      if (bindings.length > 0) {
        let table = $('<table/>').addClass('cc-table-overview')

        // order by cv, plugin, port
        bindings.sort((a,b) => {
          let result = a.cc.uri.localeCompare(b.cc.uri)

          if (result == 0) {
            result = a.pluginLabel.localeCompare(b.pluginLabel)
          }

          if (result == 0) {
            result = a.portLabel.localeCompare(b.portLabel)
          }

          return result;
        });

        const header = $('<tr><th>Actuator</th><th>Plugin</th><th>Parameter</th></tr>')
        table.append(header)
        let index = 0
        for(let binding of bindings) {
          let row = $('<tr/>')
          let cell = $(`<td><span class="cc-binding-controller">${binding.cc?.name ?? '<unknown cc port>'}</span></td>`)
          row.append(cell)

          cell = $(`<td><span class="cc-binding-plugin">${binding.pluginLabel}</span></td>`)
          row.append(cell)

          cell = $(`<td><span class="cc-binding-port">${binding.portLabel}</span></td>`)
          row.append(cell)

          if (index % 2) {
            row.addClass('odd')
          }
          if (binding.addressing && binding.addressing == currentAddressing) {
            row.addClass('selected');
          }

          table.append(row)
          row.click(function() {
            self.onSelectedAddressingChange(binding.addressingData.uri, model, binding)
            table.find('tr').removeClass('selected')
            row.addClass('selected')
          })

          index++
        }
        model.ccTable.append(table)
      } else {
        let empty = $('<div />')

        empty.addClass('no-selection').text('No Control Chain bindings defined')
        model.ccTable.append(empty)
      }
    }
    this.buildCVTable = function (model, currentAddressing) {
      model.cvTable.empty()
      let bindings = []

      for(const actuator in self.addressingsByActuator) {
        if (!isCvUri(actuator)) {
          continue
        }

        const addressings = self.addressingsByActuator[actuator]
        if (addressings?.length > 0) {
          for(let addressing of addressings) {
            let addressingData = self.addressingsData[addressing]
            if (!addressingData)
              continue

            let binding = self.parseAddressing(addressing, addressingData, model)

            binding.pluginLabel = (binding.plugin.label && binding.plugin.label.length > 0) ? binding.plugin.label : binding.plugin.effect.label
            binding.portLabel = (addressingData.label && addressingData.label.length > 0) ? addressingData.label : (binding.port?.name && binding.port.name.length > 0) ? binding.port.name : binding.portSymbol
            binding.cv = self.cvOutputPorts.find((item) => item.uri == addressingData.uri)

            bindings.push(binding)
          }
        }
      }

      if (bindings.length > 0) {
        let table = $('<table/>').addClass('cv-table-overview')

        // order by cv, plugin, port
        bindings.sort((a,b) => {
          let result = a.cv.uri.localeCompare(b.cv.uri)

          if (result == 0) {
            result = a.pluginLabel.localeCompare(b.pluginLabel)
          }

          if (result == 0) {
            result = a.portLabel.localeCompare(b.portLabel)
          }

          return result;
        });

        const header = $('<tr><th>Actuator</th><th>Plugin</th><th>Parameter</th></tr>')
        table.append(header)
        let index = 0
        for(let binding of bindings) {
          let row = $('<tr/>')
          let cell = $(`<td><span class="cv-binding-controller">${binding.cv?.name ?? '<unknown cv port>'}</span></td>`)
          row.append(cell)

          cell = $(`<td><span class="cv-binding-plugin">${binding.pluginLabel}</span></td>`)
          row.append(cell)

          cell = $(`<td><span class="cv-binding-port">${binding.portLabel}</span></td>`)
          row.append(cell)

          if (index % 2) {
            row.addClass('odd')
          }
          if (binding.addressing && binding.addressing == currentAddressing) {
            row.addClass('selected');
          }

          table.append(row)
          row.click(function() {
            self.onSelectedAddressingChange(binding.addressingData.uri, model, binding)
            table.find('tr').removeClass('selected')
            row.addClass('selected')
          })

          index++
        }
        model.cvTable.append(table)
      } else {
        let empty = $('<div />')

        empty.addClass('no-selection').text('No CV bindings defined')
        model.cvTable.append(empty)
      }
    }

    this.addOption = function (addressings, actuator, currentAddressing, select) {
      var addressedToMe = currentAddressing?.uri && currentAddressing.uri === actuator.uri
      if ((addressings && addressings.length < actuator.max_assigns) || addressedToMe) {
        $('<option>').attr('value', actuator.uri).text(actuator.name).appendTo(select)
        if (addressedToMe) {
          select.val(currentAddressing.uri)
        }
      }
    }

    this.getTitleText = function(model) {
      let label = model.plugin.label ? model.plugin.label : `${model.plugin.effect.brand} ${model.plugin.effect.label}`

      if (model.port) {
        label = label + ': ' + model.port.name
      }

      return label
    }

    this.updateView = function (model) {
        const port = model.port
        const instance = model.instance

        if (model.plugin) {
          const label = self.getTitleText(model)

          model.title_plugin_name?.text(` - ${label}`)
        } else {
          model.title_plugin_name?.text("")
        }
        let typeInputVal = model.typeInput.val()

        if (!typeInputVal) {
          typeInputVal = kNullAddressURI
        if (model.addressing?.uri)
        {
          if (model.addressing.uri == kMidiLearnURI || model.addressing.uri.lastIndexOf(kMidiCustomPrefixURI, 0) === 0) {
            typeInputVal = kMidiLearnURI
          } else if (startsWith(model.addressing.uri, deviceOption)) {
            typeInputVal = deviceOption
          } else if (startsWith(model.addressing.uri, cvOption)) {
            typeInputVal = cvOption
          } else if (model.addressing.uri !== kBpmURI){
            typeInputVal = ccOption
          }

          // restore values
          model.ledColourMode.val(model.addressing.coloured ? 1 : 0)
          model.momentarySwMode.val(model.addressing.momentary || 0)
        }
        else
        {
          if (port) {
            // If there is no addressing made yet, try to set some good defaults
            model.ledColourMode.val(port && port.properties.indexOf("preferColouredListByDefault") >= 0 ? 1 : 0)

            if (port.properties.indexOf("preferMomentaryOffByDefault") >= 0) {
              model.momentarySwMode.val(2)
            } else if (port && port.properties.indexOf("preferMomentaryOnByDefault") >= 0) {
              model.momentarySwMode.val(1)
            } else {
              model.momentarySwMode.val(0)
            }
          } else {
            model.ledColourMode.val(0)
            model.momentarySwMode.val(0)
          }

          if (model.is_overview) {
            typeInputVal = deviceOption
          }
        }

        model.typeInput.val(typeInputVal)
        }

        model.pname = (!port || port.symbol == ":bypass" || port.symbol == ":presets") ? model.plugin_label : port.shortName
        model.minv  = model.addressing?.minimum != null ? model.addressing.minimum : port?.ranges.minimum ?? 0
        model.maxv  = model.addressing?.maximum != null ? model.addressing.maximum : port?.ranges.maximum ?? 0
        model.min.val(model.minv).attr("min", port?.ranges.minimum ?? 0).attr("max", port?.ranges.maximum ?? 0)
        model.max.val(model.maxv).attr("min", port?.ranges.minimum ?? 0).attr("max", port?.ranges.maximum ?? 0)
        model.label.val(model.addressing?.label || model.pname)
        model.tempo.prop("checked", model.addressing?.tempo || false)
        // for the overview, load all available actuators just the first time
        if (model.is_overview && (model.actuators?.length ?? 0) == 0) {
          model.actuators = self.availableActuators(model.instance, model.port, model.addressing?.tempo)
        } else {
          model.actuators = self.availableActuators(model.instance, model.port, model.addressing?.tempo)
        }
        model.dividerOptions = []

        
        // Add options to control chain and cv actuators select
        var ccUri, cvUri
        var ccActuators = []
        // Clear dropdowns
        model.ccActuatorSelect.empty()
        model.cvPortSelect.empty()
        for (var uri in model.actuators) {
          ccUri = is_control_chain_uri(uri)
          cvUri = isCvUri(uri)
          if (!(cvUri || ccUri)) {
            continue
          }
          let actuator = model.actuators[uri]
          let addressings = self.addressingsByActuator[uri]

          if (ccUri) {
            ccActuators.push(actuator)
            self.addOption(addressings, actuator, model.addressing, model.ccActuatorSelect)
          } else { // cvUri
            self.addOption(addressings, actuator, model.addressing, model.cvPortSelect)
          }
        }

        if (ccActuators.length === 0) {
          model.ccActuatorSelect.hide()
        }

        self.ccActuators = ccActuators

        // Hide Tempo section if the ControlPort does not have the property mod:tempoRelatedDynamicScalePoints
        if (!hasTempoRelatedDynamicScalePoints(port)) {
          model.form.find('.tempo').css({display:"none"})
        // Else, build filtered list of divider values based on bpm and ControlPort min/max values
        } else {
          model.form.find('.tempo').css({ display: "block" })

          if (model.tempo.prop("checked")) {
            self.disableMinMaxSteps(model.form, true)
          }
          model.dividerOptions = self.buildDividerOptions(model.divider, port, model.addressing?.dividers)
        }

        if (port) {
          // show or hide min/max and step options based on port properties
          model.no_selection_placeholder.hide()
          model.form.find('.actuator-label').show()
          model.form.find('.range').show()
          model.form.find('.sensitivity').css({ display: "block" })
          
          if (port.properties.indexOf("toggled") >= 0 || port.properties.indexOf("trigger") >= 0) {
              // boolean, always min or max value
              var step = model.maxv - model.minv
              model.min.attr("step", step)
              model.max.attr("step", step)
              // hide ranges
              model.form.find('.range').hide()
          } else if (port.properties.indexOf("enumeration") >= 0) {
              // enumeration, step is list size - 1
              var step = port.scalePoints.length - 1
              model.min.attr("step", step)
              model.max.attr("step", step)
              // hide ranges
              model.form.find('.range').hide()
          } else if (port.properties.indexOf("integer") < 0) {
            // float, allow non-integer stepping
            var step = (model.maxv - model.minv) / 100
            model.min.attr("step", step)
            model.max.attr("step", step)

            // Hide sensitivity and tempo options for MIDI
            // FIXME this whole section below can likely be removed without side effects
            var act = model.typeInput.val()
            if (act === kMidiLearnURI || act.lastIndexOf(kMidiCustomPrefixURI, 0) === 0 || act === cvOption) {
              model.form.find('.sensitivity').css({ display: "none" })
              model.form.find('.tempo').css({ display: "none" })
            }
            // Hide tempo option for CC or CV
            if (act === ccOption || act === cvOption) {
              model.form.find('.tempo').css({ display: "none" })
            }

            // Hide cv operational mode for everything except CV
            if (act !== cvOption) {
              model.form.find('.cv-op-mode').css({ display: "none" })
            } else {
              model.form.find('.cv-op-mode').css({ display: "block" })
            }
          }
        } else {
          // hide all
          model.no_selection_placeholder.css({ display: "flex" })
          model.form.find('.actuator-label').hide()
          model.form.find('.range').hide()
          model.form.find('.sensitivity').css({ display: "none" })
          model.form.find('.tempo').css({ display: "none" })
        }

        if (model.is_overview) {
          // enable save only if port and addressing have a value
          if (model.port && model.addressing?.uri) {
            model.form.find('.js-save').removeClass('disabled')
            //model.form.find('.js-binding-add').addClass('disabled')
            model.form.find('.js-binding-remove').removeClass('disabled')
          } else {
            model.form.find('.js-save').addClass('disabled')
            // if not addressed and a hmiUri is selected
            // if (!model.addressing?.uri && model.hmiUriInput.val()) {
            //   model.form.find('.js-binding-add').removeClass('disabled')
            // } else {
            //   model.form.find('.js-binding-add').addClass('disabled')
            // }
            model.form.find('.js-binding-remove').addClass('disabled')
          }
        }
    }

    const _open = function (model) {
        var instanceAndSymbol = model.is_overview ? model.instance : model.instance + "/" + model.port.symbol
        
        model.addressing = self.addressingsData[instanceAndSymbol] || {}
        // Renders the window
        var form = $(options.renderForm(model.instance, model.port))

        model.form                     = form
        model.typeSelect               = form.find('select[name=type]')
        model.typeInput                = form.find('input[name=type]')
        model.hmiPageInput             = form.find('input[name=hmi-page]')
        model.hmiSubPageInput          = form.find('input[name=hmi-subpage]')
        model.hmiUriInput              = form.find('input[name=hmi-uri]')
        model.deviceTable              = form.find('.device-table')
        model.midiTable                = form.find('.midi-table')
        model.ccTable                  = form.find('.cc-table')
        model.cvTable                  = form.find('.cv-table')
        model.sensitivity              = form.find('select[name=steps]')
        model.ledColourMode            = form.find('select[name=led-color-mode]')
        model.momentarySwMode          = form.find('select[name=momentary-sw-mode]')
        model.operationalMode          = form.find('select[name=cv-op-mode]')
        model.pname                    = ""
        model.minv                     = 0
        model.maxv                     = 0
        model.min                      = form.find('input[name=min]')
        model.max                      = form.find('input[name=max]')
        model.label                    = form.find('input[name=label]')
        model.tempo                    = form.find('input[name=tempo]')
        model.divider                  = form.find('select[name=divider]')
        model.dividerOptions           = []
        model.actuators                = []
        model.ccActuatorSelect         = form.find('select[name=cc-actuator]')
        model.cvPortSelect             = form.find('select[name=cv-port]')
        model.title_plugin_name        = form.find('.overview-plugin-name')
        model.no_selection_placeholder = form.find('.no-selection')
        model.addressing               = model.addressing || {}

        model.ccActuatorSelect.change(function () {
          var actuatorUri = $(this).val()
          self.toggleAdvancedItemsVisibility(model.port,
                                              model.sensitivity, model.ledColourMode, model.momentarySwMode,
                                              model.actuators[actuatorUri],
                                              model.addressing?.uri === actuatorUri ? model.addressing.steps : null)
        })

        model.cvPortSelect.change(function () {
          self.showDynamicField(model.is_overview, model.form, model.typeInput.val(), model.addressing, model.port, $(this).val(), false)
        })

        self.getModel = function() {
          return model
        }

        self.updateView(model)

        self.buildDeviceTable(model, model.addressing)
        if (model.is_overview) {
          self.buildMidiTable(model, null)
          self.buildCVTable(model, null)
          self.buildCCTable(model, null)
        }
        var typeOptions = [kNullAddressURI, deviceOption, kMidiLearnURI, ccOption, cvOption]
        var i = 0
        // initialize tab pages visibility (after the updateView call because the typeInput is set there)
        model.typeSelect.find('option').unwrap().each(function() {
            var btn = $('<div class="btn js-type" data-value="'+typeOptions[i]+'">'+$(this).text()+'</div>');
            var jbtn = $(btn);
            if(jbtn.attr('data-value') == model.typeInput.val()) {
              btn.addClass('selected')
            }
            // Hide None tab in the pedalboard overview
            if ((!model.port || model.is_overview) && (jbtn.attr('data-value') === kNullAddressURI)) {
              jbtn.hide()
            }
            // Hide Device tab under mod-app
            else if (options.isApp() && (jbtn.attr('data-value') === deviceOption || jbtn.attr('data-value') === ccOption)) {
              jbtn.hide()
            }
            // Hide MIDI tab if not available
            else if (jbtn.attr('data-value') === kMidiLearnURI && (!model.actuators[kMidiLearnURI])) {
              jbtn.hide()
            }
            // Hide CV tab if not available
            else if (jbtn.attr('data-value') === cvOption && (model.port && !self.isCvAvailable(model.port))) {
              jbtn.hide()
            }
            $(this).replaceWith(btn)
            i++
        })
        // handle tab clicks
        form.find('.js-type').click(function () {
          form.find('.js-type').removeClass('selected')
          $(this).addClass('selected')
          model.typeInput.val($(this).attr('data-value'))

          if (model.is_overview) {
            // reset current selection only in overview
            model.port = null
            model.addressing = null
            model.plugin = null
            model.instance = null
          }
          self.showDynamicField(model.is_overview, model.form, model.typeInput.val(), model.addressing, model.port, model.cvPortSelect.val(), false)
          self.updateView(model)
        })

        // refresh  predefined tab
        self.showDynamicField(model.is_overview, model.form, model.typeInput.val(), model.addressing, model.port, model.cvPortSelect.val(), true)

        form.find('input[name=tempo]').bind('change', function() {
          self.disableMinMaxSteps(model.form, this.checked)

          if (!model.addressing?.uri) {
            if (this.checked) {
              form.find('.js-save').removeClass('disabled')
            } else if (typeInput.val() === kNullAddressURI) {
              form.find('.js-save').addClass('disabled')
            }
          }

          model.actuators = self.availableActuators(instance, port, this.checked)
          model.deviceTable.empty()
          self.buildDeviceTable(model, model.addressing)
        })

        self.saveCurrentAddressing = function() {
            self.saveAddressing(
              model.instance,
              model.port,
              model.actuators,
              model.typeInput,
              model.hmiPageInput,
              model.hmiSubPageInput,
              model.hmiUriInput,
              model.ccActuatorSelect,
              model.cvPortSelect,
              model.min,
              model.max,
              model.label,
              model.pname,
              model.sensitivity,
              model.ledColourMode,
              model.momentarySwMode,
              model.tempo,
              model.divider,
              model.dividerOptions,
              model.operationalMode,
              model.is_overview ? undefined : model.form, // this avoid close dialog in overview mode
              function(ok, addressing) {
                if (ok) {
                  // update current selection for overview mode
                  model.addressing = addressing || {}
                  if (model.is_overview) {
                    if (addressing == null) {
                      // addressing deleted, update tables
                      if (model.typeInput.val() == kMidiLearnURI) {
                        self.buildMidiTable(model, null)
                      } else if (model.typeInput.val() == ccOption) {
                        self.buildCCTable(model, null)
                      } else if (model.typeInput.val() == cvOption) {
                        self.buildCVTable(model, null)
                      }
                    } else {
                      const label = model.addressing.label;

                      if (model.addressing.uri == kMidiLearnURI) {
                        new Notification('info', 'Move the desired control on your MIDI device', 4000)
                        // refresh midi table UI
                        let row = model.midiTable.find('tr.selected')[0];

                        if (row) {
                          $($(row).addClass('learning').find('td')[2]).text('LEARNING...')
                        }
                      } else if (is_control_chain_uri(model.addressing.uri)) {
                        // update the cc table
                        model.ccTable?.find('tr.selected').find('.cc-binding-port').text(label)
                      } else if (isCvUri(model.addressing.uri)) {
                        // update the cv table
                        model.cvTable?.find('tr.selected').find('.cv-binding-port').text(label)
                      } else {
                        // update the device table
                        model.deviceTable?.find('td.selected').text(label)
                      }
                    }
                  }
                }
              }
            );

        }

        form.find('.js-save').click(function () {
            if ($(this).hasClass('disabled')) {
              return
            }
            self.saveCurrentAddressing()
        })

        form.find('.js-close').click(function () {
            form.remove()
            model.form = form = null
        })
        if (model.is_overview) {
          // change the text only for the close button
          form.find('.btn.js-close').text("Close")
          form.find('.btn.js-binding-remove').click(function() {
            if ($(this).hasClass('disabled')) {
              return
            }

            const bindingLabel = self.getTitleText(model)
            if (!confirm(`Delete '${bindingLabel}' binding?`))
              return

            const currentInputVal = model.typeInput.val()
            model.typeInput.val(kNullAddressURI)
            self.saveCurrentAddressing()

            // update model clear selection
            model.port = null
            model.addressing = {}
            model.plugin = null
            model.instance = ""
            model.plugin_label = ""

            // refresh the deviceTable UI
            model.form.find('td.selected').each((index, item) => {
              // reset the title & the test
              const element = $(item)
              const dataUri = element.attr('data-uri')
              const page = element.attr('data-page')
              const subpage = element.attr('data-subpage')
              const actuator = model.actuators[dataUri]
              let text = dataUri

              if (actuator) {
                if (actuator.actuator_group?.length > 0) { // is group
                  text = actuator.gname
                  // enable the single group actuators since we removed the group binding
                  actuator.actuator_group.forEach(groupElement => {
                    model.deviceTable
                      .find("td[data-uri='" + groupElement + "'][data-page='" + page + "'][data-subpage='" + subpage + "']")
                      .removeClass('disabled')
                  })
                } else {
                  text = actuator.name
                }
              }
              element.attr('title', null)
              element.removeClass('binded')
              element.text(text)
            })

            model.typeInput.val(currentInputVal)
            self.updateView(model)
            new Notification('warn', `${bindingLabel} binding deleted`, 8000)
          })
          // form.find('.btn.js-binding-add').click(function() {
          //   if ($(this).hasClass('disabled')) {
          //     return
          //   }
          //   console.log('add binding')
          // })
        } else {
          form.find('.btn.js-binding-remove').hide()
        }

        self.showAdvancedContainer = function(visibility) {
            if (visibility) {
              $('.mod-pedal-settings-address').find('.mod-box').animate({
                width: '916px'
              }, 100, function() {
                form.find('.advanced-container').toggle()
              });
            } else {
              form.find('.advanced-container').toggle(0, function() {
                $('.mod-pedal-settings-address').find('.mod-box').animate({
                  width: '766px'
                }, 100)
              })
            }
        }
        form.find('.advanced-toggle').click(function() {
          const visibility = !form.find('.advanced-container').is(':visible')
          self.showAdvancedContainer(visibility)
        })

        const advanced_pin_button = form.find('.advanced-pin-toggle')
        advanced_pin_button.click(function() {
            const value = !advanced_pin_button.hasClass('pinned');

            options.saveConfigValue("addressing-advanced-pinned",
                                    value ? "true" : "false",
                                    function(ok) {
                                      if (!ok) {
                                        console.log("Failed to save addressing advanced pinned state");
                                        return;
                                      }

                                      const advanced_toggle = form.find('.advanced-toggle')
                                      if (value) {
                                        advanced_pin_button.addClass('pinned')
                                        advanced_toggle.addClass('mod-hidden')
                                      } else {
                                        advanced_pin_button.removeClass('pinned')
                                        advanced_toggle.removeClass('mod-hidden')
                                      }
                                    })
        })

        if (!model?.is_overview) {
          model.title_plugin_name.hide()
        }
        $('body').keydown(function (e) {
            if (e.keyCode == 27 && form && form.is(':visible')) {
                form.remove()
                model.form = form = null
                return false
            }
        })
        form.keydown(function (e) {
            if (e.keyCode == 13) {
                self.saveAddressing(
                  model.instance,
                  model.port,
                  model.actuators,
                  model.typeInput,
                  model.hmiPageInput,
                  model.hmiSubPageInput,
                  model.hmiUriInput,
                  model.ccActuatorSelect,
                  model.cvPortSelect,
                  model.min,
                  model.max,
                  model.label,
                  model.pname,
                  model.sensitivity,
                  model.ledColourMode,
                  model.momentarySwMode,
                  model.tempo,
                  model.divider,
                  model.dividerOptions,
                  model.operationalMode,
                  model.is_overview ? undefined : model.form // this avoid close dialog in overview mode
                );
                return false
            }
        })

        if (model.is_overview) {
          model.form.find('.js-save').addClass('disabled').text('Modify')
          model.form.find('.assign-label').text("Assigned to")
        }

        form.appendTo($('body'))
        form.focus()

        // initial advanced container visibility
        if (PREFERENCES["addressing-advanced-pinned"] === "true") {
          self.showAdvancedContainer(true)
          advanced_pin_button.addClass('pinned')
          form.find('.advanced-toggle').addClass('mod-hidden')
        }
    }

    // Opens an addressing window to address this a port
    this.open = function (instance, port, plugin_label) {
      let model = {
        instance: instance,
        is_overview: false,
        port: port,
        plugin_label: plugin_label,
        plugins: null,
        plugin: null
      }
      _open(model)
    }

    // Opens an overview addressing window with all bindings listed
    this.open_overview = function (instance, plugins) {
      let model = {
        instance: instance,
        is_overview: true,
        port: null,
        plugin_label: "",
        plugins: plugins,
        plugin: null
      }
      _open(model)
    }

    this.addressNow = function (
      instance,
      port,
      actuator,
      minv,
      maxv,
      labelValue,
      sensitivityValue,
      tempoValue,
      dividerValue,
      dividerOptions,
      page,
      subpage,
      colouredValue,
      momentarySwValue,
      operationalModeValue,
      form,
      callback
      ) {
        var instanceAndSymbol = instance+"/"+port.symbol;
        var currentAddressing = self.addressingsData[instanceAndSymbol] || {}

        var portValuesWithDividerLabels = []
        // Sync port value to bpm
        if (tempoValue && dividerValue && port.units && port.units.symbol) {
          if (port.units.symbol === 'BPM') {
            port.value = getPortValue(self.beatsPerMinutePort.value, dividerValue, port.units.symbol) // no need for conversion
          } else {
            port.value = convertSecondsToPortValueEquivalent(
              getPortValue(self.beatsPerMinutePort.value, dividerValue, port.units.symbol),
              port.units.symbol
            );
          }
        }

        var addressing = {
            uri    : actuator.uri || kNullAddressURI,
            label  : labelValue,
            minimum: minv,
            maximum: maxv,
            value  : port.value,
            steps  : sensitivityValue,
            tempo  : tempoValue,
            dividers: dividerValue,
            feedback: actuator.feedback === false ? false : true, // backwards compatible, true by default
            page: page || null,
            subpage: subpage || null,
            coloured: colouredValue,
            momentary: momentarySwValue,
            operationalMode: operationalModeValue,
        }

        options.address(instanceAndSymbol, addressing, function (ok) {
            if (!ok) {
                console.log("Addressing failed for port " + port.symbol);
                return;
            }
            // remove old one first
            var unaddressing = false
            if (currentAddressing.uri && currentAddressing.uri != kNullAddressURI) {
                unaddressing = true
                if (startsWith(currentAddressing.uri, kMidiCustomPrefixURI)) {
                    currentAddressing.uri = kMidiLearnURI
                }
                remove_from_array(self.addressingsByActuator[currentAddressing.uri], instanceAndSymbol)
            }

            // We're addressing
            let updatedAddressing = null
            if (actuator.uri && actuator.uri != kNullAddressURI)
            {
                var actuator_uri = actuator.uri
                if (startsWith(actuator_uri, kMidiCustomPrefixURI)) {
                    actuator_uri = kMidiLearnURI
                }

                // if kMidiLearnURI it will be inserted when the host will call addMidiMapping
                if (actuator_uri != kMidiLearnURI) {
                  // add new one, print and error if already there
                  if (self.addressingsByActuator[actuator_uri].indexOf(instanceAndSymbol) < 0) {
                    self.addressingsByActuator[actuator_uri].push(instanceAndSymbol)
                  } else {
                    console.log("ERROR HERE, please fix!")
                  }
                }

                // remove data needed by the server, useless for us
                delete addressing.value

                // convert some values to proper type
                addressing.coloured = !!addressing.coloured
                addressing.momentary = parseInt(addressing.momentary)

                // now save
                self.addressingsByPortSymbol[instanceAndSymbol] = actuator.uri
                self.addressingsData        [instanceAndSymbol] = addressing

                // disable this control
                var feedback = actuator.feedback === false ? false : true // backwards compat, true by default
                options.setEnabled(instance, port.symbol, false, feedback, true, addressing.momentary)

                updatedAddressing = addressing
            }
            // We're unaddressing: there were a previous binding
            else if (unaddressing)
            {
                delete self.addressingsByPortSymbol[instanceAndSymbol]
                delete self.addressingsData        [instanceAndSymbol]

                // enable this control
                options.setEnabled(instance, port.symbol, true)
            }

            if (form !== undefined) {
              form.remove()
              form = null
            }

            if (callback) {
              callback(ok, updatedAddressing)
            }
        })
    }

    this.saveAddressing = function (
      instance,
      port,
      actuators,
      typeInput,
      hmiPageInput,
      hmiSubPageInput,
      hmiUriInput,
      ccActuatorSelect,
      cvPortSelect,
      min,
      max,
      label,
      pname,
      sensitivity,
      ledColourMode,
      momentarySwMode,
      tempo,
      divider,
      dividerOptions,
      operationalMode,
      form,
      callback /* function(ok, addressing) */
      ) {
        var instanceAndSymbol = instance+"/"+port.symbol
        var currentAddressing = self.addressingsData[instanceAndSymbol] || {}

        var page = hmiPageInput.val()
        var subpage = hmiSubPageInput.val()
        var typeInputVal = typeInput.val()
        var uri = kNullAddressURI
        if (typeInputVal === deviceOption && hmiUriInput.val()) {
          uri = hmiUriInput.val()
        } else if(typeInputVal === ccOption && ccActuatorSelect.val()) {
          uri = ccActuatorSelect.val()
        } else if(typeInputVal === cvOption && cvPortSelect.val()) {
          uri = cvPortSelect.val()
        } else if (typeInputVal === kMidiLearnURI) {
          uri = kMidiLearnURI
        }
        var actuator = actuators[uri] || {}

        var tempoValue = tempo.prop("checked")
        // Sync port value to bpm with virtual bpm actuator
        if (tempoValue && uri === kNullAddressURI) {
          actuator = {
            uri  : kBpmURI,
            modes: ":float:integer:",
            steps: [],
            max_assigns: 99
          }
        }

        // no actuator selected or old one exists, do nothing
        if (actuator.uri == null && currentAddressing.uri == null) {
            console.log("Nothing to do")
            if (form !== undefined) {
              form.remove()
              form = null
            }
            return
        }

        // Check values
        var minv = min.val()
        if (minv == undefined || minv == "")
            minv = port.ranges.minimum

        var maxv = max.val()
        if (maxv == undefined || maxv == "")
            maxv = port.ranges.maximum

        if (parseFloat(minv) >= parseFloat(maxv)) {
            alert("The minimum value is equal or higher than the maximum. We cannot address a control like this!")
            return
        }

        var labelValue = label.val() || pname
        var sensitivityValue = sensitivity.val()
        var dividerValue = divider.val() ? parseFloat(divider.val()): divider.val()
        var colouredValue = ledColourMode.hasClass('disabled') ? 0 : parseInt(ledColourMode.val())
        var momentarySwValue = momentarySwMode.hasClass('disabled') ? 0 : parseInt(momentarySwMode.val())
        var operationalModeValue = operationalMode.val()

        // if changing from midi-learn, unlearn first
        if (currentAddressing.uri == kMidiLearnURI) {
            var addressing = {
                uri    : kMidiUnlearnURI,
                label  : labelValue,
                minimum: minv,
                maximum: maxv,
                value  : port.value,
                steps  : sensitivityValue,
            }
            options.address(instanceAndSymbol, addressing, function (ok) {
                if (!ok) {
                    console.log("Failed to unmap for port " + port.symbol);
                    return;
                }

                // remove old one
                remove_from_array(self.addressingsByActuator[kMidiLearnURI], instanceAndSymbol)

                delete self.addressingsByPortSymbol[instanceAndSymbol]
                delete self.addressingsData        [instanceAndSymbol]

                // enable this control
                options.setEnabled(instance, port.symbol, true)

                // now we can address if needed
                if (actuator.uri) {
                  self.addressNow(
                    instance,
                    port,
                    actuator,
                    minv,
                    maxv,
                    labelValue,
                    sensitivityValue,
                    tempoValue,
                    dividerValue,
                    dividerOptions,
                    page,
                    subpage,
                    colouredValue,
                    momentarySwValue,
                    operationalModeValue,
                    form,
                    callback
                  );
                // if not, just close the form
                } else if (form !== undefined) {
                    form.remove()
                    form = null
                }
            })
        }
        // otherwise just address it now
        else {
          self.addressNow(
            instance,
            port,
            actuator,
            minv,
            maxv,
            labelValue,
            sensitivityValue,
            tempoValue,
            dividerValue,
            dividerOptions,
            page,
            subpage,
            colouredValue,
            momentarySwValue,
            operationalModeValue,
            form,
            callback
          );
        }
    }

    this.addHardwareMapping = function (instance, portSymbol, actuator_uri,
                                        label, minimum, maximum, steps,
                                        tempo, dividers, page, subpage, group, feedback, coloured, momentary) {
        var instanceAndSymbol = instance+"/"+portSymbol
        self.addressingsByActuator  [actuator_uri].push(instanceAndSymbol)
        self.addressingsByPortSymbol[instanceAndSymbol] = actuator_uri
        self.addressingsData        [instanceAndSymbol] = {
            uri     : actuator_uri,
            label   : label,
            minimum : minimum,
            maximum : maximum,
            steps   : steps,
            tempo   : tempo,
            dividers: dividers,
            feedback: feedback,
            page    : page,
            subpage : subpage,
            group   : group,
            coloured: coloured,
            momentary: momentary
        }
        // disable this control if needed
        options.setEnabled(instance, portSymbol, false, feedback, true, momentary)
    }

    this.addCvMapping = function (instance, portSymbol, actuator_uri,
                                        label, minimum, maximum, operationalMode, feedback) {
        var instanceAndSymbol = instance+"/"+portSymbol

        self.addressingsByActuator  [actuator_uri].push(instanceAndSymbol)
        self.addressingsByPortSymbol[instanceAndSymbol] = actuator_uri
        self.addressingsData        [instanceAndSymbol] = {
            uri     : actuator_uri,
            label   : label,
            minimum : minimum,
            maximum : maximum,
            feedback: feedback,
            operationalMode: operationalMode,
        }
        // disable this control
        options.setEnabled(instance, portSymbol, false, feedback, true)
    }

    this.addMidiMapping = function (instance, portSymbol, channel, control, minimum, maximum) {
        var instanceAndSymbol = instance+"/"+portSymbol
        var actuator_uri = create_midi_cc_uri(channel, control)

        if (self.addressingsByPortSymbol[instanceAndSymbol] == kMidiLearnURI) {
            var controlstr = (control == MIDI_PITCHBEND_AS_CC) ? "Pitchbend" : ("Controller #" + control)
            new Notification('info', "Parameter mapped to MIDI " + controlstr + ", Channel " + (channel+1), 8000)
        }

        self.addressingsByActuator  [kMidiLearnURI].push(instanceAndSymbol)
        self.addressingsByPortSymbol[instanceAndSymbol] = actuator_uri
        self.addressingsData        [instanceAndSymbol] = {
            uri     : actuator_uri,
            label   : null,
            minimum : minimum,
            maximum : maximum,
            steps   : null,
            feedback: true,
        }

        // disable this control
        options.setEnabled(instance, portSymbol, false, true, true)

        const model = self.getModel ? self.getModel() : undefined

        if (model && model.is_overview) {
          if (!model.addressing || model.addressing.uri == kMidiLearnURI) {
            // if midi learning selected the learned addressing
            const addressing = self.parseAddressing(instanceAndSymbol, self.addressingsData[instanceAndSymbol], model)
            self.onSelectedAddressingChange(actuator_uri, model, addressing)
          }
          self.buildMidiTable(model, instanceAndSymbol)
          self.updateView(model)
        }
    }

    this.addActuator = function (actuator) {
        HARDWARE_PROFILE.push(actuator)
        self.addressingsByActuator[actuator.uri] = []
    }

    this.hasControlChainDevice = function (actuator) {
        for (var i in HARDWARE_PROFILE) {
            if (is_control_chain_uri(HARDWARE_PROFILE[i].uri)) {
                return true;
            }
        }
        return false;
    }

    this.removeActuator = function (actuator_uri) {
        var addressings = self.addressingsByActuator[actuator_uri]

        for (var i in addressings) {
            var instanceAndSymbol = addressings[i]
            var instance          = instanceAndSymbol.substring(0, instanceAndSymbol.lastIndexOf("/"))
            var portsymbol        = instanceAndSymbol.replace(instance+"/", "")

            delete self.addressingsByPortSymbol[instanceAndSymbol]
            delete self.addressingsData        [instanceAndSymbol]

            // enable this control
            options.setEnabled(instance, portsymbol, true)
        }

        delete self.addressingsByActuator[actuator_uri]

        for (var i in HARDWARE_PROFILE) {
            var actuator = HARDWARE_PROFILE[i]
            if (actuator.uri == actuator_uri) {
                remove_from_array(HARDWARE_PROFILE, actuator)
                break
            }
        }
    }

    // Removes an instance
    this.removeInstance = function (instance) {
        var i, j, index, actuator, instanceAndSymbol, instanceAndSymbols = []
        var instanceSansGraph = instance.replace("/graph/","")

        var keys = Object.keys(self.addressingsByPortSymbol)
        for (i in keys) {
            instanceAndSymbol = keys[i]
            if (instanceAndSymbol.replace("/graph/","").split(/\//)[0] == instanceSansGraph) {
                if (instanceAndSymbols.indexOf(instanceAndSymbol) < 0) {
                    instanceAndSymbols.push(instanceAndSymbol)
                }
            }
        }

        for (i in instanceAndSymbols) {
            instanceAndSymbol = instanceAndSymbols[i]
            delete self.addressingsByPortSymbol[instanceAndSymbol]
            delete self.addressingsData        [instanceAndSymbol]

            for (j in HARDWARE_PROFILE) {
                actuator = HARDWARE_PROFILE[j]
                remove_from_array(self.addressingsByActuator[actuator.uri], instanceAndSymbol)
            }
        }
    }

    // used only for global pedalboard addressings
    // don't use it for normal operations, as it skips setEnabled()
    this.removeHardwareMappping = function (instanceAndSymbol) {
        var actuator_uri = self.addressingsByPortSymbol[instanceAndSymbol]

        delete self.addressingsByPortSymbol[instanceAndSymbol]
        delete self.addressingsData        [instanceAndSymbol]

        if (actuator_uri && actuator_uri != kNullAddressURI) {
            remove_from_array(self.addressingsByActuator[actuator_uri], instanceAndSymbol)
            return true
        }

        return false
    }

    this.addCvOutputPort = function (uri, name, operationalMode) {
      var existingPort = self.cvOutputPorts.find(function (port) {
        return port.uri === uri;
      })
      if (existingPort) {
        existingPort.name = name
      } else {
        self.cvOutputPorts.push({
          uri: uri,
          name: name,
          modes: cvModes,
          steps: [],
          max_assigns: 99,
          feedback: false,
          defaultOperationalMode: operationalMode,
        })
        self.addressingsByActuator[uri] = []
      }
    }

    this.removeCvOutputPort = function (uri) {
      var isAddressable = false
      self.cvOutputPorts = self.cvOutputPorts.filter(function (port) {
        if (port.uri === uri) {
          isAddressable = true
        }
        return port.uri !== uri
      });

      if (!isAddressable) {
        return
      }

      for (var i in self.addressingsByActuator[uri]) {
        instanceAndSymbol = self.addressingsByActuator[uri][i]
        delete self.addressingsData[instanceAndSymbol]
        delete self.addressingsByPortSymbol[instanceAndSymbol]

        var separatedInstanceAndSymbol = getInstanceSymbol(instanceAndSymbol)
        options.setEnabled(separatedInstanceAndSymbol[0], separatedInstanceAndSymbol[1], true)
      }

      delete self.addressingsByActuator[uri]
    }
}
