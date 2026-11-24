# Pathscope NC Viewer

[Open the free viewer](https://rezalari.github.io/pathscope-nc-viewer/)

Drop an NC or G-code file into your browser to inspect its toolpaths and see the solid material left after each cut. The viewer includes a working example you can explore immediately. Your files are processed on your device. The viewer also works offline if you download `docs/index.html`.

## Using the viewer

1. Choose **Open NC file** or drop a file onto the viewer. The included arc-pocket plate opens at the finished shape. Press **Play** to see how it was cut.
2. For your own file, open **Setup**, then confirm the stock dimensions, stock lower corner, and each tool's shape and diameter. Click **Apply stock & tools**. Enter dimensions in millimeters.
3. Switch between **Solid**, **Toolpaths**, and **Cut depth**. Drag the timeline in either direction or jump to a stage or hole. Use **After stage** or **Finished part** to inspect the remaining material.
4. Drag to rotate the solid, Shift-drag to pan, and scroll to zoom.

The simulation samples material removed from the top of the stock. Missing tool diameters leave some cuts unmodeled. Unsupported commands can shorten the preview and appear in its notices. Verify workholding, tool changes, clearance, and offsets in the machine and CAM setup before machining.

## Running from source

Use Node.js 20 or later. The build uses only Node's standard library.

```sh
node build.mjs
node src/tests/viewer.test.cjs docs/index.html
node src/tests/viewer.test.cjs docs/index.html --no-solid
```

Open `docs/index.html` in a modern browser. The build embeds the app and demonstration program in one HTML file. GitHub Pages serves the checked-in `docs/` directory from `main`. If you edit the source or example, rebuild and commit the updated HTML too.

The [sample program](examples/demo.nc) includes examples of the optional stock and tool comments the viewer understands.

