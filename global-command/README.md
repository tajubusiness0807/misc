# Global Command

An intercontinental, turn-based tactical war game that runs in the browser. Seven powers fight for a
hex-grid map of the real world, built from Natural Earth coastlines, with 101 real cities to capture.

No build step and no dependencies: open `index.html` in a browser, or serve the folder with any static
file server:

```bash
cd global-command && python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Features

- **The world as a battlefield.** 96×42 wrapping hex map (fly or sail across the Pacific), seven terrain
  types with real mountain ranges, deserts and forests, canals at Panama and Cairo, and nine regions
  that pay a bonus when you hold every city in them.
- **Seven powers.** Columbia Union, Southern Cross, European Directorate, Pan-African Coalition, Northern
  Federation, Pacific Concord and Indus Compact. Play any of them, leave some out, or watch the
  computer powers fight in observer mode.
- **Ten unit types across land, sea and air.** Infantry, armor, artillery, anti-air, fighters, bombers,
  destroyers, submarines, battleships and carriers, each with its own attack against land, air, sea
  and submarine targets.
- **Tactical combat.** Terrain and city defence, entrenchment, zones of control, counter-attacks,
  indirect fire, anti-air cover, stealthy submarines, fog of war, and a damage forecast before every
  attack.
- **Intercontinental reach.** Land units embark to cross oceans, carriers carry aircraft, and cities can
  build ICBMs (range 32) that enemy anti-air may intercept.
- **Computer opponents** that expand, garrison threatened cities, gang up on a runaway leader, use
  ranged units and aircraft carefully, and launch missiles when it pays.
- Save/load (browser storage, plus an autosave each turn), three difficulty levels, adjustable AI
  speed, synthesised sound effects, and touch support.

## How to win

Hold every starting capital, control 60% of all cities, or eliminate every rival. You lose when you
have no cities left. Press **How to play** in the game for the full rules and controls.

## Code layout

| File | Purpose |
| --- | --- |
| `js/mapdata.js` | Generated hex terrain map (see below) |
| `js/data.js` | Terrain, unit stats, rules constants, powers, cities, regions |
| `js/hex.js` | Hex-grid math (odd-r offset layout, east–west wrap) |
| `js/game.js` | Game state and rules: movement, combat, production, missiles, turns, save/load |
| `js/ai.js` | Computer opponents |
| `js/render.js` | Canvas renderer, effects and minimap |
| `js/ui.js` | Input, panels, turn flow and animated playback |
| `js/audio.js` | Web Audio sound effects |

## Regenerating the map

`js/mapdata.js` is generated from the Natural Earth land polygons in the
[world-atlas](https://github.com/topojson/world-atlas) package:

```bash
curl -o land-50m.json https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json
node tools/build-map.mjs land-50m.json > js/mapdata.js
```

Terrain features (mountain ranges, deserts, forests) and the strait fixes are defined at the top of
`tools/build-map.mjs`.
