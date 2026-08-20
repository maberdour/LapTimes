# LapTap for Coaches

A phone-first timing app for coaches. Time up to four riders at once, on the track, with large tap targets and no network required after install.

Live site: [coach.letsrace.cc](https://coach.letsrace.cc/)

## What it does

Each rider gets a full-screen colour card. Tap to start, tap again each time they cross the line. The card shows remaining laps, elapsed time, and a final-lap flash with a bell.

Sessions stay on the device. Install the app to the home screen before race day so it still works with no phone signal.

## Features

- Up to four riders, each with a name, visual identifier, and colour
- Course presets: 6, 12, or 18 laps, 10 miles, or a custom opening segment plus full laps
- Independent starts so riders do not have to go off together
- Undo for the last start, lap, or finish
- Splits, total time, and average lap for finished riders
- Share or download an Excel workbook (Summary and Splits sheets)
- Offline PWA with a service worker cache
- Screen wake lock while anyone is still racing
- Session stored in `localStorage`

## Using it

1. Open the site and install it to the home screen when prompted (recommended).
2. Set the distance and add riders. Each rider needs a name and a unique visual identifier (kit colour, number, etc.).
3. On the timing grid, tap a rider to start them, then tap again at each crossing.
4. A finished rider’s card opens their splits. Use **Results** for totals, **Share Excel** to export, or **Reset times** to clear the session without wiping riders.

Changing rider names or colours keeps recorded laps. Changing the number of laps starts a new session.

## Run locally

This is a static site: `index.html`, `app.js`, `sw.js`, and `manifest.json`. Serve the folder over HTTP so the service worker and install prompt can run.

```bash
python3 -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080).

## Stack

Vanilla HTML, CSS, and JavaScript. No build step and no dependencies. GitHub Pages (or equivalent) hosts the site via the `CNAME` for `coach.letsrace.cc`.
