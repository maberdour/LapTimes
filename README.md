# LapTap for Coaches

A phone-first timing app for coaches. Time up to four riders at once, on the track, with large tap targets and no network required after install.

Live site: [coach.letsrace.cc](https://coach.letsrace.cc/)

## What it does

Each rider gets a lap recording card. Tap to start, tap again each time they cross the line to complete a lap. The card shows remaining laps, elapsed time, and a final-lap flash with a bell.

Sessions stay on the device until it is reset. Install the app to the home screen before race day and it will work with no phone signal.

## Features

- Up to four riders, each with a name, colour, and optional visual identifier
- Course presets: 1, 6, 12, or 18 laps, 10 miles, or a custom opening segment plus full laps
- Independent starts so riders do not have to go off together
- An Undo feature if you tap a lap prematurely
- Splits, total time, and average lap for finished riders
- Share or download an Excel workbook
- Screen wake lock while anyone is still racing
  
## Technical spec
- Offline PWA with a service worker cache
- Session stored in `localStorage`

## Using it
1. Open the URL and install it to the home screen when prompted (recommended).
2. Set the distance and add riders. Each rider needs a name. A visual identifier (kit colour, number, etc.) is optional, and unique if used.
3. On the timing grid, tap a rider to start them, then tap again at each crossing.
4. A finished rider’s card opens their splits (except on 1-lap courses). Use **Results** for totals, **Share Excel** to export, or **Reset times** to clear the session.

Changing rider names or colours keeps recorded laps. Changing the number of laps resets the session.

## Stack
- Vanilla HTML, CSS, and JavaScript. No build step and no dependencies. 
- GitHub Pages (or equivalent) hosts the site via the `CNAME` for `coach.letsrace.cc`.
