// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later



/*
 * performance view behaviour
 *
 * The interface for managing your pedal board parameters on a touch device
 *
 * Properties:
 */

JqueryClass('performanceBox', {
    init: function (options) {
        var self = $(this)

        options = $.extend({
            pedalboard: undefined,
            pedalPresets: undefined,
            resultCanvasPlugins: self.find('.js-performance-plugins'),
            resultCanvasPluginSettings: self.find('.js-performance-plugin-settings'),
            selectedElement: undefined,
            selectedIndex: -1,
            selectElement: function (element, callback) {
                const pedalboard = self.data("pedalboard")

                if (pedalboard) {
                    let selectedIndex = -1
                    const displaySelectedElementSettings = self.data("displaySelectedElementSettings")
                    const currSelectedIndex = self.data("selectedIndex")

                    // remove selected from the current selected element
                    if (currSelectedIndex >= 0) {
                        $("#mod-performance-plugin-" + currSelectedIndex.toString())?.removeClass("selected");
                    }

                    if (element === ":presets") {
                        const pedalPresets = self.data("pedalPresets")
                        let div = document.createElement("div")
                        
                        pedalPresets.getPedalPresetList(function(presets) {
                            let data = []
                            
                            Object.keys(presets).forEach(key => data.push({index: data.length + 1, label: presets[key]}) )
                            div.innerHTML = Mustache.render(TEMPLATES.performance_snapshots, {presets: data})
                            let rendered = $(Array.prototype.slice.call(div.childNodes, 0))
                            const settings = rendered[0];
                            
                            // add the selected class
                            $("#mod-performance-plugin-0")?.addClass("selected")    
                            selectedIndex = 0;
                            displaySelectedElementSettings(element, selectedIndex, settings, function() {
                                // attach events
                                $(".performance .snapshot").each(function(index, snapshotDiv) {
                                    snapshotDiv.onclick = function (e) {
                                        pedalPresets.loadPreset(index, e.target.innerText)
                                    }
                                });
                            })
                        });
                    } else {
                        //TODO: if element is plugin, show plugin settings
                        const plugin = element
                        const plugins = pedalboard.data("plugins")
                        const settings = plugin.settingsPerformance[0];
                        
                        selectedIndex = Object.keys(plugins).indexOf(plugin.instance) + 1 // +1 'cause 0 is the snapshot page
                        displaySelectedElementSettings(element, selectedIndex, settings)
                        $("#mod-performance-plugin-" + selectedIndex.toString())?.addClass("selected")
                    }
                }
               
            },

            // show the settings for the selected plugin or snapshots
            displaySelectedElementSettings: function(selectedElement, selectedIndex, settings, callback) {
                const settingsContainer = self.data('resultCanvasPluginSettings')
                const settingsDiv = settingsContainer[0];

                if (settingsDiv) {
                    $(settingsDiv).fadeOut(200, function() {
                        settingsDiv.innerHTML = ""
                        
                        if (settings) {
                            settingsDiv.appendChild(settings);
                            $(settingsDiv).fadeIn(200);
                        }
                        
                        self.data("selectedElement", selectedElement)
                        self.data("selectedIndex", selectedIndex)
                        if (callback)
                            callback([])
                    })
                }
            },

            isMainWindow: true,
            windowName: "Performance",
        }, options)

        self.data(options)

        options.open = function () {
            var plugins = []
            const pedalboard = self.data("pedalboard")

            if (pedalboard)
            {
                const plugins = pedalboard.data("plugins")
                const canvas = self.data("resultCanvasPlugins")

                canvas[0].innerHTML = ""

                // append snapshot view
                var div = document.createElement("div");
        
                div.innerHTML = Mustache.render(TEMPLATES.plugin, {
                    uri   : ":presets",
                    brand : "&nbsp;",
                    label : "Snapshots",
                    thumbnail_href: "/resources/presets.png"
                });
                var rendered = $(Array.prototype.slice.call(div.childNodes, 0))

                rendered[0].id = "mod-performance-plugin-0"

                rendered.click(function () {
                    self.data("selectElement")(":presets")
                })
                canvas.append(rendered);

                // TODO: controls assigned to phisical mod

                // append effects controls one by one
                let index = 1
                for (pluginKey in plugins) { 
                    const plugin = plugins[pluginKey].data("gui"); 
                    
                    self.performanceBox("renderPlugin", index, plugin, canvas)
                    index += 1
                }

                self.data("selectElement")(":presets")
            }
            return false
        }

        const canvas = self.data("resultCanvasPlugins")
        canvas.bind("mousewheel", function(event, delta, deltaX, deltaY) {
            let index = self.data("selectedIndex")
            
            index -= deltaY;
            if (index < 0)
                index = 0;
        
            const pluginDiv = $("#mod-performance-plugin-" + index.toString())

            if (pluginDiv && pluginDiv[0]) {
                const divTop = pluginDiv[0].offsetTop;
                let selectedElement;

                if (index == 0) { // snapshots
                    selectedElement = ":presets";
                } else {
                    const plugin = pluginDiv.data("plugin")

                    if (plugin) {
                        selectedElement = plugin
                    }
                }
                self.data('selectElement')(selectedElement)
                canvas.scrollTop(divTop);
            }
            event.preventDefault();
        });
        canvas.bind("swipe", function(e) {
            console.log(`swipe ${e}`)
        })
        self.window(options)

        return self
    },

    renderPlugin: function (index, plugin, container) {
        var self = $(this)
        if (container.length == 0)
            return
        var uri = escape(plugin.effect.uri)
        var ver = [plugin.effect.builder, plugin.effect.microVersion, plugin.effect.minorVersion, plugin.effect.release].join('_')

        var plugin_data = {
            uri   : uri,
            brand : plugin.effect.brand || "&nbsp;",
            label : plugin.effect.label,
            thumbnail_href: (plugin.effect.gui && plugin.effect.gui.thumbnail)
                          ? ("/effect/image/thumbnail.png?uri=" + uri + "&v=" + ver)
                          :  "/resources/pedals/default-thumbnail.png",
        }

        if (window.devicePixelRatio && window.devicePixelRatio >= 2) {
            plugin_data.thumbnail_href = plugin_data.thumbnail_href.replace("thumbnail","screenshot")
        }

        var div = document.createElement("div");
        
        div.innerHTML = Mustache.render(TEMPLATES.plugin, plugin_data);
        var rendered = $(Array.prototype.slice.call(div.childNodes, 0));

        rendered[0].id = "mod-performance-plugin-" + index.toString()
        $(rendered).data('plugin', plugin)
        rendered[0].setAttribute('mod-instance', plugin.instance)

        rendered.click(function () {
            self.data('selectElement')(plugin)
        })

        container.append(rendered)
    }
})
