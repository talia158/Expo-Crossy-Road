// End-to-end smoke test: generate ~10 frames against the running dev server,
// postprocess (rotate 14.5° CCW + emit YOLO boxes), and write side-by-side
// overlay images so the boxes can be eyeballed against the rotated frames.
//
// Output: dataset_test/{images,labels,overlays}/frame_NNNNNN.{png,txt,png}

import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const URL = process.env.GAME_URL ?? "http://localhost:8081";
const OUT_DIR = path.resolve(ROOT, "dataset_test");
const IMG_DIR = path.join(OUT_DIR, "images");
const LBL_DIR = path.join(OUT_DIR, "labels");
const OVR_DIR = path.join(OUT_DIR, "overlays");
const W = 240, H = 480;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hand-picked diverse scenarios (~10 frames spanning car/train/log/mixed).
const TEST_SCENARIOS = [
  { name: "single_car_v0_x0",      kind: "cars",  z: "road",  configs: [{ variant: 0, x: 0, dir: 1 }] },
  { name: "single_truck_v2_x-1",   kind: "cars",  z: "road",  configs: [{ variant: 2, x: -1, dir: 1 }] },
  { name: "single_truck_v6_x1",    kind: "cars",  z: "road",  configs: [{ variant: 6, x: 1, dir: -1 }] },
  { name: "two_cars_sp3",          kind: "cars",  z: "road",  configs: [{ variant: 1, x: -1.5, dir: 1 }, { variant: 7, x: 1.5, dir: 1 }] },
  { name: "three_mixed_cars",      kind: "cars",  z: "road",  configs: [{ variant: 2, x: -2, dir: 1 }, { variant: 0, x: 0, dir: -1 }, { variant: 6, x: 2, dir: 1 }] },
  { name: "single_log_v0_x0",      kind: "logs",  z: "water", configs: [{ variant: 0, x: 0, dir: 1 }] },
  { name: "single_log_v3_x-1",     kind: "logs",  z: "water", configs: [{ variant: 3, x: -1, dir: 1 }] },
  { name: "two_logs",              kind: "logs",  z: "water", configs: [{ variant: 0, x: -2, dir: 1 }, { variant: 3, x: 2, dir: 1 }] },
  { name: "train_size2_x0",        kind: "train", z: "rail",  config:  { x: 0, size: 2, dir: 1 } },
  { name: "train_size3_x-2",       kind: "train", z: "rail",  config:  { x: -2, size: 3, dir: 1 } },
];

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(IMG_DIR, { recursive: true });
  await fs.mkdir(LBL_DIR, { recursive: true });
  await fs.mkdir(OVR_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!window.__crossyDataset && !!window.__crossyEngine?.gameMap?.floorMap,
    { timeout: 60000 }
  );
  await sleep(500);
  await page.evaluate(() => window.dispatchEvent(
    new KeyboardEvent("keyup", { keyCode: 32, key: " ", which: 32 })
  ));
  await sleep(700);
  await page.evaluate(() => {
    const c = window.__crossyDataset;
    c.freeze(); c.hideHero(); c.clearAll();
  });

  const glRect = await page.evaluate(() => {
    for (const c of document.querySelectorAll("canvas")) {
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (gl) { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; }
    }
    return null;
  });

  const rows = await page.evaluate(() => {
    const r = window.__crossyDataset.getRowsInfo();
    const inView = (z) => z >= 10 && z <= 19;
    const pickClosest = (type) =>
      r.filter((x) => x.type === type && inView(x.z))
        .sort((a, b) => Math.abs(a.z - 14) - Math.abs(b.z - 14))[0]?.z;
    return { road: pickClosest("road"), water: pickClosest("water"), rail: pickClosest("railRoad") };
  });
  console.log(`rows: road=${rows.road} water=${rows.water} rail=${rows.rail}`);

  let frame = 0;
  for (const sc of TEST_SCENARIOS) {
    const z = rows[sc.z];
    if (z == null) { console.log(`  skip ${sc.name} (no ${sc.z} row)`); continue; }
    const placement = sc.kind === "train"
      ? { kind: "train", z, config: sc.config }
      : { kind: sc.kind, z, configs: sc.configs };
    await page.evaluate((p) => {
      const c = window.__crossyDataset;
      c.freeze(); c.hideHero(); c.clearAll();
      if (p.kind === "cars") c.placeCarsOnRow(p.z, p.configs);
      else if (p.kind === "train") c.placeTrainOnRow(p.z, p.config);
      else if (p.kind === "logs") c.placeLogsOnRow(p.z, p.configs);
    }, placement);
    await page.evaluate(() => new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    ));

    const { lines, boxes } = await page.evaluate(() => ({
      lines: window.__crossyDataset.getRotatedFootprints(),
      boxes: window.__crossyDataset.getRotatedBoxes(),
    }));

    frame++;
    const id = String(frame).padStart(6, "0");
    const buf = await page.screenshot({
      clip: { x: glRect.x, y: glRect.y, width: W, height: H },
      type: "png",
    });
    await fs.writeFile(path.join(IMG_DIR, `frame_${id}.png`), buf);
    await fs.writeFile(
      path.join(OUT_DIR, `frame_${id}.json`),
      JSON.stringify({ name: sc.name, lines, boxes, placement }, null, 2)
    );
    console.log(`  frame_${id}: ${sc.name} → ${boxes.length} boxes`);
  }

  await browser.close();
  console.log(`\ngenerated ${frame} test frames; running rotate+overlay…`);

  const py = spawnSync("python3", [path.join(ROOT, "scripts/test_overlay.py")], {
    stdio: "inherit",
  });
  if (py.status !== 0) process.exit(py.status ?? 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
