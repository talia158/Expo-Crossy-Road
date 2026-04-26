// Generates a YOLO-style training dataset by driving the running clone in
// headless Chromium. For each scenario template we re-roll the world map
// N_MAPS times so the same scenario is captured against multiple backdrops.
//
// Usage:
//   1) Start the Expo web dev server:  bun run start --web
//      Confirm http://localhost:8081 loads the game.
//   2) node scripts/generate_dataset.mjs
//
// Output:
//   dataset/images/frame_NNNNNN.png      (240x480 PNGs)
//   dataset/labels/frame_NNNNNN.json     (per-frame: image, w, h, lines:[{class,x1,y1,x2,y2}], scenario, mapSeed)
//   dataset/index.json                   (manifest)
//   dataset/manifest_yolo.txt            (image paths)

import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const URL = process.env.GAME_URL ?? "http://localhost:8081";
const N_MAPS = Number(process.env.N_MAPS ?? 4);
const OUT_DIR = path.resolve(ROOT, "dataset");
const IMG_DIR = path.join(OUT_DIR, "images");
const LBL_DIR = path.join(OUT_DIR, "labels");
const FRAME_W = 240;
const FRAME_H = 480;
const CAR_VARIANTS = 8;
const LOG_VARIANTS = 4;
const SCREEN_MARGIN = 5;

// Visible world-x range for our camera (empirically calibrated).
const X_RANGE = [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];
const NEAR_X = [-2, -1, 0, 1, 2];
const OVERLAP_BUFFER = 0.2; // world-unit gap required between adjacent objects

let frameId = 0;
let WIDTHS = { cars: [], logs: [], trains: [] };
const manifest = [];

// Drop configs that would horizontally overlap any earlier-kept config in the
// same lane. Widths come from the actual mesh bounding boxes.
function filterOverlap(configs, kind) {
  const widthFor = (cfg) => {
    if (kind === "cars") return WIDTHS.cars[cfg.variant] ?? 2.5;
    if (kind === "logs") return WIDTHS.logs[cfg.variant ?? 0] ?? 3;
    return 0;
  };
  const kept = [];
  for (const cfg of configs) {
    const w = widthFor(cfg);
    const lo = cfg.x - w / 2;
    const hi = cfg.x + w / 2;
    const collides = kept.some((k) => {
      const wk = widthFor(k);
      return lo < k.x + wk / 2 + OVERLAP_BUFFER && hi > k.x - wk / 2 - OVERLAP_BUFFER;
    });
    if (!collides) kept.push(cfg);
  }
  return kept;
}

// Same idea but per-row across placements: returns a new placements array with
// overlapping configs filtered out within each row.
function dedupePlacements(placements) {
  return placements
    .map((p) => {
      if (p.kind === "cars" || p.kind === "logs") {
        const configs = filterOverlap(p.configs, p.kind);
        return { ...p, configs };
      }
      return p;
    })
    .filter((p) => !((p.kind === "cars" || p.kind === "logs") && p.configs.length === 0));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDirs() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(IMG_DIR, { recursive: true });
  await fs.mkdir(LBL_DIR, { recursive: true });
}

async function waitForGame(page) {
  await page.waitForFunction(
    () => !!window.__crossyDataset && !!window.__crossyEngine?.gameMap?.floorMap,
    { timeout: 60000 }
  );
  await sleep(500);
}

async function findGLCanvasRect(page) {
  return await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    for (const c of canvases) {
      let isGL = false;
      try {
        const gl = c.getContext("webgl2") || c.getContext("webgl");
        if (gl) isGL = true;
      } catch {}
      if (isGL) {
        const r = c.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
    }
    return null;
  });
}

// Dismiss the HomeScreen overlay (Space → onPlay), then freeze + hide hero.
async function setupBaseScene(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { keyCode: 32, key: " ", which: 32 }));
  });
  await sleep(700);
  await page.evaluate(() => {
    const c = window.__crossyDataset;
    c.freeze();
    c.hideHero();
    c.clearAll();
  });
}

// Re-roll the world: call engine.init() so a new random map is generated.
// We stay frozen + hero-detached across this since freeze just no-ops tick
// and hero detachment isn't reset by init().
async function reinitMap(page) {
  await page.evaluate(() => {
    const e = window.__crossyEngine;
    e.init();
    const c = window.__crossyDataset;
    c.freeze();
    c.hideHero();
    c.clearAll();
  });
  await sleep(150);
}

async function getRowsByType(page) {
  return await page.evaluate(() => {
    const rows = window.__crossyDataset.getRowsInfo();
    const byType = {};
    for (const r of rows) (byType[r.type] = byType[r.type] || []).push(r.z);
    return byType;
  });
}

// Pick rows within the visible z range, sorted by proximity to screen center.
function pickRows(rowsByType) {
  const Z_MIN = 10;
  const Z_MAX = 19;
  const TARGET = 14;
  const inView = (z) => z >= Z_MIN && z <= Z_MAX;
  const choose = (type) =>
    (rowsByType[type] || [])
      .filter(inView)
      .sort((a, b) => Math.abs(a - TARGET) - Math.abs(b - TARGET));
  return {
    road: choose("road"),
    rail: choose("railRoad"),
    water: choose("water"),
  };
}

async function captureFrame(page, glRect, scenario, mapSeed) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  );

  const { lines, boxes } = await page.evaluate(() => ({
    lines: window.__crossyDataset.getRotatedFootprints(),
    boxes: window.__crossyDataset.getRotatedBoxes(),
  }));

  const inFrame = ({ x1, y1, x2, y2 }) => {
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    return (
      maxX >= -SCREEN_MARGIN &&
      minX <= FRAME_W + SCREEN_MARGIN &&
      maxY >= -SCREEN_MARGIN &&
      minY <= FRAME_H + SCREEN_MARGIN
    );
  };
  const onScreen = lines.filter(inFrame);
  const onScreenBoxes = boxes.filter(inFrame);

  const id = String(++frameId).padStart(6, "0");
  const imgRel = `images/frame_${id}.png`;
  const lblRel = `labels/frame_${id}.json`;

  const buffer = await page.screenshot({
    clip: { x: glRect.x, y: glRect.y, width: FRAME_W, height: FRAME_H },
    type: "png",
  });
  await fs.writeFile(path.join(OUT_DIR, imgRel), buffer);

  const label = {
    image: imgRel,
    width: FRAME_W,
    height: FRAME_H,
    lines: onScreen,
    boxes: onScreenBoxes,
    scenario,
    mapSeed,
  };
  await fs.writeFile(path.join(OUT_DIR, lblRel), JSON.stringify(label, null, 2));
  manifest.push({ image: imgRel, label: lblRel, scenario: scenario.name, mapSeed });
  if (frameId % 50 === 0) console.log(`  captured ${frameId} frames…`);
}

async function applyAndCapture(page, glRect, name, placements, mapSeed) {
  placements = dedupePlacements(placements);
  await page.evaluate((placements) => {
    const c = window.__crossyDataset;
    c.freeze();
    c.hideHero();
    c.clearAll();
    for (const p of placements) {
      if (p.kind === "cars") c.placeCarsOnRow(p.z, p.configs);
      else if (p.kind === "train") c.placeTrainOnRow(p.z, p.config);
      else if (p.kind === "logs") c.placeLogsOnRow(p.z, p.configs);
    }
  }, placements);
  await captureFrame(page, glRect, { name, placements }, mapSeed);
}

// Scenario generators: take selected `rows` (road/rail/water arrays) and yield
// {name, placements}. Each generator is independent so missing row types simply
// skip its scenarios for that map.
function* genCarVariants(rows) {
  if (!rows.road.length) return;
  const z = rows.road[0];
  for (let v = 0; v < CAR_VARIANTS; v++)
    for (const x of X_RANGE)
      for (const dir of [1, -1])
        yield {
          name: `car_v${v}_x${x}_d${dir}_z${z}`,
          placements: [{ kind: "cars", z, configs: [{ variant: v, x, dir }] }],
        };
}

function* genMultiCar(rows) {
  if (!rows.road.length) return;
  const z = rows.road[0];
  const spacings = [2.5, 3, 3.5, 4];
  for (const sp of spacings) {
    for (const v of [0, 2, 5, 7]) {
      for (const dir of [1, -1]) {
        const configs = [
          { variant: v, x: -3, dir },
          { variant: (v + 1) % CAR_VARIANTS, x: -3 + sp, dir },
          { variant: (v + 2) % CAR_VARIANTS, x: -3 + sp * 2, dir },
        ];
        yield {
          name: `multi_car_sp${sp}_v${v}_d${dir}_z${z}`,
          placements: [{ kind: "cars", z, configs }],
        };
      }
    }
  }
}

function* genCrossRow(rows) {
  if (rows.road.length < 2) return;
  for (let i = 0; i + 1 < Math.min(rows.road.length, 4); i++) {
    const r1 = rows.road[i];
    const r2 = rows.road[i + 1];
    for (const x of NEAR_X) {
      for (const dx of [-0.5, 0, 0.5]) {
        yield {
          name: `cross_z${r1}_${r2}_x${x}_dx${dx}`,
          placements: [
            { kind: "cars", z: r1, configs: [{ variant: 1, x, dir: 1 }] },
            { kind: "cars", z: r2, configs: [{ variant: 4, x: x + dx, dir: -1 }] },
          ],
        };
      }
    }
  }
}

function* genStackedRows(rows) {
  if (rows.road.length < 3) return;
  const stack = rows.road.slice(0, Math.min(4, rows.road.length));
  for (const x of [-2, -1, 0, 1, 2]) {
    const placements = stack.map((z, i) => ({
      kind: "cars",
      z,
      configs: [
        {
          variant: i % CAR_VARIANTS,
          x: x + (i % 2 ? 0.4 : -0.4),
          dir: i % 2 ? 1 : -1,
        },
      ],
    }));
    yield { name: `stack_x${x}`, placements };
  }
}

function* genTrains(rows) {
  if (!rows.rail.length) return;
  const z = rows.rail[0];
  for (const size of [1, 2, 3]) {
    for (const x of [-6, -4, -2, 0, 2, 4, 6]) {
      for (const dir of [1, -1]) {
        yield {
          name: `train_s${size}_x${x}_d${dir}_z${z}`,
          placements: [{ kind: "train", z, config: { x, size, dir } }],
        };
      }
    }
  }
}

function* genTrainPlusCars(rows) {
  if (!rows.rail.length || !rows.road.length) return;
  const tz = rows.rail[0];
  const cz = rows.road[0];
  for (const tx of [-3, 0, 3]) {
    for (const cx of [-2, 0, 2]) {
      yield {
        name: `train_car_tx${tx}_cx${cx}_z${tz}_z${cz}`,
        placements: [
          { kind: "train", z: tz, config: { x: tx, size: 2 } },
          { kind: "cars", z: cz, configs: [{ variant: 3, x: cx, dir: 1 }] },
        ],
      };
    }
  }
}

function* genLogs(rows) {
  if (!rows.water.length) return;
  const z = rows.water[0];
  for (let v = 0; v < LOG_VARIANTS; v++) {
    for (const x of X_RANGE) {
      for (const dir of [1, -1]) {
        yield {
          name: `log_v${v}_x${x}_d${dir}_z${z}`,
          placements: [{ kind: "logs", z, configs: [{ variant: v, x, dir }] }],
        };
      }
    }
  }
}

function* genMultiLog(rows) {
  if (!rows.water.length) return;
  const z = rows.water[0];
  for (const sp of [3, 4, 5]) {
    for (let v = 0; v < LOG_VARIANTS; v++) {
      yield {
        name: `multi_log_sp${sp}_v${v}_z${z}`,
        placements: [
          {
            kind: "logs",
            z,
            configs: [
              { variant: v, x: -3, dir: 1 },
              { variant: (v + 1) % LOG_VARIANTS, x: -3 + sp, dir: 1 },
              { variant: (v + 2) % LOG_VARIANTS, x: -3 + sp * 2, dir: 1 },
            ],
          },
        ],
      };
    }
  }
}

function* genMixedScenes(rows) {
  if (!rows.road.length || !rows.rail.length || !rows.water.length) return;
  for (let seed = 0; seed < 25; seed++) {
    const placements = [];
    for (const z of rows.road.slice(0, 3)) {
      const n = 1 + ((seed + z) % 3);
      const cfgs = [];
      let x = -2.5 + ((seed + z) % 2);
      for (let i = 0; i < n; i++) {
        cfgs.push({
          variant: (seed + z + i) % CAR_VARIANTS,
          x,
          dir: (i + seed) % 2 ? 1 : -1,
        });
        x += 2.8 + ((seed % 3) * 0.4);
      }
      placements.push({ kind: "cars", z, configs: cfgs });
    }
    for (const z of rows.rail.slice(0, 1)) {
      placements.push({
        kind: "train",
        z,
        config: { x: -3 + (seed % 7), size: 1 + (seed % 3), dir: seed % 2 ? 1 : -1 },
      });
    }
    for (const z of rows.water.slice(0, 2)) {
      const cfgs = [];
      let x = -2.5 + ((seed + z) % 2);
      for (let i = 0; i < 2; i++) {
        cfgs.push({
          variant: (seed + i) % LOG_VARIANTS,
          x,
          dir: seed % 2 ? 1 : -1,
        });
        x += 3.2 + (seed % 2);
      }
      placements.push({ kind: "logs", z, configs: cfgs });
    }
    yield { name: `mixed_seed${seed}`, placements };
  }
}

function* genEdgeCases(rows) {
  if (!rows.road.length) return;
  const z = rows.road[0];
  for (const x of [-6, -5, -4, 4, 5, 6]) {
    for (let v = 0; v < CAR_VARIANTS; v++) {
      yield {
        name: `edge_v${v}_x${x}_z${z}`,
        placements: [{ kind: "cars", z, configs: [{ variant: v, x, dir: 1 }] }],
      };
    }
  }
}

const SCENARIO_GENERATORS = [
  genCarVariants,
  genMultiCar,
  genCrossRow,
  genStackedRows,
  genTrains,
  genTrainPlusCars,
  genLogs,
  genMultiLog,
  genMixedScenes,
  genEdgeCases,
];

async function main() {
  await ensureDirs();
  console.log(`Launching Chromium and opening ${URL}…`);
  console.log(`Will run scenarios across ${N_MAPS} map rolls.`);

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[page error]", msg.text());
  });

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  console.log("Waiting for game to initialize…");
  await waitForGame(page);
  await setupBaseScene(page);

  WIDTHS = await page.evaluate(() => window.__crossyDataset.getObjectWidths());
  console.log(
    `Object widths: cars=[${WIDTHS.cars.map((w) => w.toFixed(2)).join(",")}] ` +
      `logs=[${WIDTHS.logs.map((w) => w.toFixed(2)).join(",")}] ` +
      `trains=[${WIDTHS.trains.map((w) => w.toFixed(2)).join(",")}]`
  );

  const glRect = await findGLCanvasRect(page);
  if (!glRect) throw new Error("Could not locate GLView canvas");
  console.log(`GLView at (${glRect.x.toFixed(1)}, ${glRect.y.toFixed(1)}) ${glRect.width}x${glRect.height}`);

  for (let mapSeed = 0; mapSeed < N_MAPS; mapSeed++) {
    if (mapSeed > 0) await reinitMap(page);

    // Demand a useful mix of row types — re-roll up to a few times if missing.
    let rows;
    for (let attempt = 0; attempt < 6; attempt++) {
      const byType = await getRowsByType(page);
      rows = pickRows(byType);
      if (rows.road.length && rows.rail.length && rows.water.length) break;
      await reinitMap(page);
    }
    console.log(
      `\nMap ${mapSeed}: roads=[${rows.road.join(",")}] rails=[${rows.rail.join(",")}] waters=[${rows.water.join(",")}]`
    );

    let scenarioCount = 0;
    for (const gen of SCENARIO_GENERATORS) {
      for (const scenario of gen(rows)) {
        await applyAndCapture(
          page,
          glRect,
          `m${mapSeed}_${scenario.name}`,
          scenario.placements,
          mapSeed
        );
        scenarioCount++;
      }
    }
    console.log(`  Map ${mapSeed} produced ${scenarioCount} frames.`);
  }

  await fs.writeFile(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify({ count: manifest.length, n_maps: N_MAPS, frames: manifest }, null, 2)
  );
  await fs.writeFile(
    path.join(OUT_DIR, "manifest_yolo.txt"),
    manifest.map((m) => m.image).join("\n")
  );

  console.log(`\nDone. Wrote ${manifest.length} frames to ${OUT_DIR}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
