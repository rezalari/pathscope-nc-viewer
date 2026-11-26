# Pathscope NC Viewer

[Open the free viewer](https://rezalari.github.io/pathscope-nc-viewer/)

Drop an NC or G-code file into your browser to inspect its toolpaths and see the solid material left after each cut. The viewer includes a working example you can explore immediately. Your files are processed on your device. The viewer also works offline if you download `docs/index.html`.

## Using the viewer

1. Choose **Open NC file** or drop a file onto the viewer. When the viewer finds a cutter size and a spindle-on feed, it opens at the finished shape. Drag the timeline back or press **Play** to watch material come off.
2. In **Setup**, check the stock dimensions and lower corner. The viewer reads numbered cutter comments throughout the program, including descriptions beside tool changes. If a size is missing, enter the cutter shape and diameter in millimeters, then choose **Apply stock & tools**.
3. Switch between **Solid**, **Toolpaths**, and **Cut depth**. Drag the timeline in either direction or jump to a stage or hole. Use **After stage** or **Finished part** to inspect the remaining material.
4. Scroll the **G-code** listing or enter a physical line number and choose **Go**. Selecting a line pauses at its first simulated motion, including the first segment of an arc or drilling cycle. A comment or other non-motion line jumps to the next motion. A line after the last motion jumps to the end. The listing follows playback and timeline changes. With the listing focused, use the arrow keys, Page Up, Page Down, Home or End to select lines.

In **Solid**, the **Removed material** checkbox shows the volume already machined away in translucent cyan. **Cutter** shows the active tool at its simulated position. The readout reports removed volume and estimates spindle-on feed time spent in air up to the displayed frame. Both estimates depend on the stock, tool dimensions, and simulation grid. Rapids and moves with unknown cutter sizes are excluded from the air-feed estimate.

Drag to rotate the solid, Shift-drag to pan, and scroll to zoom.

The simulation samples material removed from the top of the stock. Missing tool diameters leave some cuts unmodeled. Unsupported commands can shorten the preview and appear in its notices. Verify workholding, tool changes, clearance, and offsets in the machine and CAM setup before machining.

## Running from source

Use Node.js 20 or later. The build uses only Node's standard library.

```sh
node build.mjs
node src/tests/viewer.test.cjs docs/index.html
node src/tests/viewer.test.cjs docs/index.html --no-solid
node --test src/tests/source-list.test.cjs src/tests/cutter-stock.test.cjs src/tests/removed-material.test.cjs src/tests/chamfer.test.cjs
```

Open `docs/index.html` in a modern browser. The build embeds the app and demonstration program in one HTML file. GitHub Pages serves the checked-in `docs/` directory from `main`. If you edit the source or example, rebuild and commit the updated HTML too.

The [sample program](examples/demo.nc) includes examples of the optional stock and tool comments the viewer understands.

For a chamfer mill, a comment such as `(TOOL T8 D6 CHAMFER A90 TIP0.5)` specifies a 6 mm outer diameter, 90° included angle and 0.5 mm flat tip diameter. These dimensions are in millimeters even in an inch program. You can also enter them in **Setup**. Use a zero tip diameter for a pointed cutter.

