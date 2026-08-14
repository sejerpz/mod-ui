# MIDI Ports

![MIDI Ports](help/img/midi-ports.png)

This button opens the MIDI ports list, where you can define how the physical (both USB and DIN/TRS) and virtual ports are displayed on the Pedalboard Constructor.
- **Enable Virtual MIDI Loopback:** when checked, this enables a virtual MIDI loopback that acts like if you would connect a cable directly from the MIDI out back to the  MIDI In port of your device. It will also add a MIDI port on the output section of the Pedalboard Constructor, where you can connect MIDI chains that will be re-routed back in the device.
- **Aggregated Mode:** when selected, displays all the physical MIDI inputs and outputs (DIN/TRS or USB) as a single input and output on the Pedalboard Constructor.
- **Separated Mode:** when selected, displays all the physical MIDI inputs and outputs (DIN/TRS or USB) separately on the Pedalboard Constructor. Therefore, it shows as many MIDI inputs and outputs as the amount MIDI ports available on MIDI devices that you have connected

When you have the USB MIDI active on your device the following port will show:
- **USB Gadget MIDI 1 (in+out):** when active, a MIDI in and out porta specifically for the MIDI messages using the USB port B connection will become available to use
- Any other USB MIDI device will also be listen in this section. In order to make it available, check the boxes for the ones you wish to use.

Please note that the MIDI ports list settings are defined and saved together with the pedalboard.


**For more info check [this page](https://wiki.mod.audio/wiki/MOD_Web_GUI_User_Guide#MIDI_ports_setup).