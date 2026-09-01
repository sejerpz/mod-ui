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
            visibleFilter: true,
            selectedElement: undefined,
            selectedIndex: -1,
            plugins: [], // filtered plugins
            isMainWindow: true,
            windowName: "Performance",
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
                            selectedIndex = 0;

                            displaySelectedElementSettings(element, selectedIndex, settings, function() {
                                self.data('scrollAndSelectElement')("#mod-performance-plugin-0")

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
                        const plugins = self.data("plugins")
                        const settings = plugin.settingsPerformance[0];

                        selectedIndex = plugins.indexOf(plugin) + 1 // +1 'cause 0 is the snapshot page

                        displaySelectedElementSettings(element, selectedIndex, settings)
                        self.data('scrollAndSelectElement')("#mod-performance-plugin-" + selectedIndex.toString())
                    }
                }
            },

            scrollAndSelectElement: function(elementSelector) {
                let element = $(elementSelector)

                if (element && element[0]) {
                    element.addClass("selected")
                    element[0].scrollIntoView({
                        "behavior" : "smooth",
                        "block": "start",
                        "container": "nearest",
                        "inline": "nearest"
                    });
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

            /*
             * Update the plugin effect list
             */
            updatePlugins: function() {
                const pedalboard = self.data("pedalboard")

                if (!pedalboard)
                    return

                const plugins = pedalboard.data("plugins")
                const canvas = self.data("resultCanvasPlugins")

                canvas[0].innerHTML = ""

                // append snapshot view
                var div = document.createElement("div");
        
                div.innerHTML = Mustache.render(TEMPLATES.performance_plugin, {
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
                const visibleFilter = self.data("visibleFilter")
                var guis = []

                for (pluginKey in plugins) {
                    guis.push(plugins[pluginKey].data("gui"))
                }
                guis = guis
                        .filter(item => !visibleFilter || item.getPerformanceOptions()?.visible === visibleFilter)
                        .sort(function(a,b) {
                            const pa = a.getPerformanceOptions()
                            const pb = b.getPerformanceOptions()

                            if (pa.index < pb.index)
                                return -1
                            else if (pa.index > pb.index)
                                return 1
                            else {
                                if (a.label < b.label)
                                    return -1
                                else if (a.label > b.label)
                                    return 1
                                else
                                    return 0
                            }
                        })

                let index = 1
                self.data('plugins', guis)
                for (key in guis) { 
                    const gui = guis[key];
                    
                    self.performanceBox("renderPlugin", index, gui, canvas)
                    index += 1
                }

                self.data("selectElement")(":presets")
            },

        }, options)

        self.data(options)

        options.open = function () {
            // check the default for the visibleFilter: if any plugin is favorite the filter will be true on oper
            const pedalboard = self.data("pedalboard")

            if (pedalboard) {
                let defaultvisibleFilter = false;
                const plugins = pedalboard.data("plugins")
                for (pluginKey in plugins) {
                    const gui = plugins[pluginKey].data("gui")

                    if (gui.getPerformanceOptions().visible) {
                        defaultvisibleFilter = true;
                        break;
                    }
                }

                self.data('visibleFilter', defaultvisibleFilter)
            }
            self.data('updatePlugins')()
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
            }
            event.preventDefault();
        });
        canvas.bind("swipe", function(e) {
            console.log(`swipe ${e}`)
        })

        const visibleFilterButton = self.find('#performance-filter-favorites')
        visibleFilterButton.click(function() {
            const newValue = !self.data('visibleFilter')

            if (newValue) {
                visibleFilterButton.addClass("is-favorite")
                visibleFilterButton.removeClass('icon-eye-off')
                visibleFilterButton.addClass('icon-eye')
            } else {
                visibleFilterButton.removeClass("is-favorite")
                visibleFilterButton.removeClass('icon-eye')
                visibleFilterButton.addClass('icon-eye-off')
            }

            self.data('visibleFilter', newValue)
            self.data('updatePlugins')()
        });
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
            brand : !plugin.effect.brand ? "&nbsp;": plugin.effect.brand,
            label : plugin.label || plugin.effect.label,
            thumbnail_href: (plugin.effect.gui && plugin.effect.gui.thumbnail)
                          ? ("/effect/image/thumbnail.png?uri=" + uri + "&v=" + ver)
                          :  "/resources/pedals/default-thumbnail.png",
        }

        if (window.devicePixelRatio && window.devicePixelRatio >= 2) {
            plugin_data.thumbnail_href = plugin_data.thumbnail_href.replace("thumbnail","screenshot")
        }

        const visibleFilter = self.data('visibleFilter')
        var div = document.createElement("div");

        div.innerHTML = Mustache.render(TEMPLATES.performance_plugin, plugin_data);
        var rendered = $(Array.prototype.slice.call(div.childNodes, 0));

        rendered[0].id = "mod-performance-plugin-" + index.toString()
        $(rendered).data('plugin', plugin)
        rendered[0].setAttribute('mod-instance', plugin.instance)

        const iconFavorite = rendered.find('.icon-favorite')

        if (iconFavorite) {
            if (visibleFilter === false) {
                iconFavorite.removeClass('hidden')
                if (plugin.getPerformanceOptions()?.visible ?? false) {
                    iconFavorite.addClass("icon-eye")
                    iconFavorite.addClass("is-favorite")
                } else {
                    iconFavorite.addClass("icon-eye-off")
                }
                iconFavorite.click(function(e) {
                    const performanceOptions = plugin.getPerformanceOptions()
                    const visible = !(performanceOptions.visible ?? false);

                    if (visible) {
                        iconFavorite.removeClass('icon-eye-off')
                        iconFavorite.addClass("icon-eye")
                        iconFavorite.addClass("is-favorite")
                    } else {
                        iconFavorite.addClass('icon-eye-off')
                        iconFavorite.removeClass("icon-eye")
                        iconFavorite.removeClass("is-favorite")
                    }
                    console.log(`plugin ${plugin.instance} toggle favorite: ${visible}`)
                    
                    performanceOptions.visible = visible
                    // let the host know about this change
                    desktop.pedalboard.data('performancePluginVisibilitySet')(plugin.instance, visible)

                    e.stopPropagation()
                })
            } else {
                iconFavorite.addClass('hidden')
            }
        }

        rendered.click(function () {
            self.data('selectElement')(plugin)
        })

        container.append(rendered)
    }
})
