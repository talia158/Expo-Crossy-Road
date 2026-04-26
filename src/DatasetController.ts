import { Box3, Vector3 } from "three";

import ModelLoader from "./ModelLoader";

type CarConfig = { variant: number | string; x: number; dir?: number };
type TrainConfig = { x: number; size?: number; dir?: number };
type LogConfig = { variant?: number | string; x: number; dir?: number };

export default class DatasetController {
  engine: any;
  _origTick: any = null;

  constructor(engine: any) {
    this.engine = engine;
  }

  freeze = () => {
    if (this._origTick) return;
    this._origTick = this.engine.tick;
    this.engine.tick = () => {};
  };

  unfreeze = () => {
    if (this._origTick) {
      this.engine.tick = this._origTick;
      this._origTick = null;
    }
  };

  // Remove all dynamic objects (cars, trains, logs) from every row.
  // Keeps grass/road/water/railRoad surfaces and lily pads (static water entities).
  clearAll = () => {
    for (const row of Object.values(this.engine.gameMap.floorMap) as any[]) {
      const { type, entity } = row;
      if (type === "road") {
        for (const car of entity.cars) entity.road.remove(car.mesh);
        entity.cars = [];
      } else if (type === "railRoad") {
        if (entity.train?.mesh) {
          entity.railRoad.remove(entity.train.mesh);
        }
        entity.train = null;
        entity._trainMesh = null;
        entity.active = false;
      } else if (type === "water") {
        const remaining: any[] = [];
        for (const e of entity.entities) {
          if (e.speed !== 0 && e.dir !== 0) {
            entity.floor.remove(e.mesh);
          } else {
            remaining.push(e);
          }
        }
        entity.entities = remaining;
      }
    }
  };

  // Wipe lily pads too (full clear, including static water decorations).
  clearAllIncludingStatic = () => {
    this.clearAll();
    for (const row of Object.values(this.engine.gameMap.floorMap) as any[]) {
      const { type, entity } = row;
      if (type === "water") {
        for (const e of entity.entities) entity.floor.remove(e.mesh);
        entity.entities = [];
      }
    }
  };

  placeCarsOnRow = (z: number, configs: CarConfig[]): boolean => {
    const row = this.engine.gameMap.floorMap[`${z}`];
    if (!row || row.type !== "road") return false;
    const entity = row.entity;
    for (const car of entity.cars) entity.road.remove(car.mesh);
    entity.cars = [];

    const box = new Box3();
    for (const cfg of configs) {
      const mesh = ModelLoader._car.getNode(`${cfg.variant}`);
      box.setFromObject(mesh);
      const width = Math.round(box.max.z - box.min.z);
      const dir = cfg.dir ?? 1;
      mesh.position.set(cfg.x, 0.25, 0);
      mesh.rotation.y = (Math.PI / 2) * dir;
      entity.road.add(mesh);
      entity.cars.push({
        mesh,
        dir,
        width,
        collisionBox: entity.heroWidth / 2 + width / 2 - 0.1,
        speed: 0,
      });
    }
    entity.active = true;
    return true;
  };

  placeTrainOnRow = (z: number, cfg: TrainConfig): boolean => {
    const row = this.engine.gameMap.floorMap[`${z}`];
    if (!row || row.type !== "railRoad") return false;
    const entity = row.entity;
    if (entity.train?.mesh) entity.railRoad.remove(entity.train.mesh);

    const size = cfg.size ?? 2;
    const dir = cfg.dir ?? 1;
    const trainMesh = ModelLoader._train.withSize(size);
    const box = new Box3().setFromObject(trainMesh);
    const width = Math.round(box.max.x - box.min.x);

    trainMesh.position.set(cfg.x, 0, 0.1);
    trainMesh.rotation.y = dir < 0 ? Math.PI : 0;
    entity.railRoad.add(trainMesh);
    entity._trainMesh = trainMesh;
    entity.train = {
      mesh: trainMesh,
      speed: 0,
      width,
      collisionBox: entity.heroWidth / 2 + width / 2 - 0.1,
    };
    entity.active = true;
    return true;
  };

  placeLogsOnRow = (z: number, configs: LogConfig[]): boolean => {
    const row = this.engine.gameMap.floorMap[`${z}`];
    if (!row || row.type !== "water") return false;
    const entity = row.entity;
    const remaining: any[] = [];
    for (const e of entity.entities) {
      if (e.speed !== 0 && e.dir !== 0) {
        entity.floor.remove(e.mesh);
      } else {
        remaining.push(e);
      }
    }
    entity.entities = remaining;

    const box = new Box3();
    for (const cfg of configs) {
      const mesh =
        cfg.variant !== undefined
          ? ModelLoader._log.getNode(`${cfg.variant}`)
          : ModelLoader._log.getRandom();
      box.setFromObject(mesh);
      const width = Math.round(box.max.x - box.min.x);
      const dir = cfg.dir ?? 1;
      mesh.position.set(cfg.x, -0.1, 0);
      entity.floor.add(mesh);
      entity.entities.push({
        mesh,
        top: 0.3,
        min: -0.3,
        mid: -0.1,
        dir,
        width,
        collisionBox: entity.heroWidth / 2 + width / 2 - 0.1,
        // Mark with a sentinel non-zero speed so getMovingObjectFootprints picks
        // it up while still being functionally static (freeze suppresses tick).
        speed: 0.0001 * dir,
      });
    }
    entity.active = true;
    return true;
  };

  // Returns rotated endpoints in screen-space, matching FootprintCanvas exactly.
  getRotatedFootprints = (): Array<{
    class: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }> => {
    const angle = (14.5 * Math.PI) / 180;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const fps = this.engine.getMovingObjectFootprints();
    return fps.map((fp: any) => {
      const mx = (fp.x1 + fp.x2) / 2;
      const hw = (fp.x2 - fp.x1) / 2;
      return {
        class: fp.type,
        x1: mx - hw * cosA,
        y1: fp.y - hw * sinA,
        x2: mx + hw * cosA,
        y2: fp.y + hw * sinA,
      };
    });
  };

  // Per-object screen-space AABB after applying the 14.5° CCW frame rotation
  // around the image center. We project all 8 corners of each mesh's 3D
  // bounding box, rotate them in pixel space, and take the AABB. This gives
  // the exact axis-aligned box that surrounds the object in the rotated image.
  getRotatedBoxes = (): Array<{
    class: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }> => {
    const W = 240, H = 480;
    const cx = W / 2, cy = H / 2;
    const ANG = (14.5 * Math.PI) / 180;
    const cosA = Math.cos(ANG), sinA = Math.sin(ANG);

    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    const v = new Vector3();
    const project = (wx: number, wy: number, wz: number) => {
      v.set(wx, wy, wz).project(cam);
      const sx = ((v.x + 1) / 2) * W;
      const sy = ((-v.y + 1) / 2) * H;
      const dx = sx - cx, dy = sy - cy;
      return { x: cx + dx * cosA + dy * sinA, y: cy - dx * sinA + dy * cosA };
    };

    const box = new Box3();
    const aabb = (mesh: any, cls: string) => {
      box.setFromObject(mesh);
      const { min, max } = box;
      const corners = [
        project(min.x, min.y, min.z), project(max.x, min.y, min.z),
        project(min.x, max.y, min.z), project(max.x, max.y, min.z),
        project(min.x, min.y, max.z), project(max.x, min.y, max.z),
        project(min.x, max.y, max.z), project(max.x, max.y, max.z),
      ];
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const p of corners) {
        if (p.x < x1) x1 = p.x; if (p.x > x2) x2 = p.x;
        if (p.y < y1) y1 = p.y; if (p.y > y2) y2 = p.y;
      }
      return { class: cls, x1, y1, x2, y2 };
    };

    const out: any[] = [];
    for (const row of Object.values(this.engine.gameMap.floorMap) as any[]) {
      const { type, entity } = row;
      if (type === "road" && entity.active) {
        for (const car of entity.cars) out.push(aabb(car.mesh, "car"));
      } else if (type === "railRoad" && entity.active && entity.train?.mesh) {
        out.push(aabb(entity.train.mesh, "train"));
      } else if (type === "water" && entity.active) {
        for (const e of entity.entities) if (e.speed) out.push(aabb(e.mesh, "log"));
      }
    }
    return out;
  };

  // Per-variant horizontal widths in world units, measured from the mesh
  // bounds in the axis that becomes the lane direction at render time
  // (cars rotate 90° so we use z; logs and trains stay along x).
  getObjectWidths = (): { cars: number[]; logs: number[]; trains: number[] } => {
    const box = new Box3();
    const widthsZ = (loader: any, n: number) =>
      Array.from({ length: n }, (_, i) => {
        const m = loader.getNode(`${i}`);
        box.setFromObject(m);
        return box.max.z - box.min.z;
      });
    const widthsX = (loader: any, n: number) =>
      Array.from({ length: n }, (_, i) => {
        const m = loader.getNode(`${i}`);
        box.setFromObject(m);
        return box.max.x - box.min.x;
      });
    const trains = [1, 2, 3].map((size) => {
      const m = ModelLoader._train.withSize(size);
      box.setFromObject(m);
      return box.max.x - box.min.x;
    });
    return {
      cars: widthsZ(ModelLoader._car, DatasetController.CAR_VARIANTS),
      logs: widthsX(ModelLoader._log, DatasetController.LOG_VARIANTS),
      trains,
    };
  };

  getRowsInfo = (): Array<{ z: number; type: string }> => {
    return Object.entries(this.engine.gameMap.floorMap)
      .map(([z, row]: any) => ({ z: Number(z), type: row.type }))
      .sort((a, b) => a.z - b.z);
  };

  // Hide the player by detaching from the scene. Toggling `visible` or moving
  // the hero gets overridden by GSAP animations on hero.position. We always
  // re-detach because engine.init() re-parents the hero to scene.world.
  hideHero = () => {
    const h = this.engine._hero;
    if (!h) return;
    h.stopAnimations?.();
    if (h.parent) h.parent.remove(h);
  };

  showHero = () => {
    const h = this.engine._hero;
    if (!h || h.parent) return;
    this.engine.scene.world.add(h);
  };

  // Force the camera to a fixed position (no scroll while building scenarios).
  // The world-with-camera offset is what scrolls, so reset it.
  resetCamera = () => {
    if (this.engine.scene?.worldWithCamera) {
      this.engine.scene.worldWithCamera.position.set(0, 0, 0);
    }
    if (this.engine.scene?.world) {
      this.engine.scene.world.position.set(0, 0, 0);
    }
  };

  // Force a render (game loop normally drives this; useful right after edits).
  renderFrame = () => {
    if (!this.engine.renderer || !this.engine.scene || !this.engine.camera) return;
    this.engine.renderer.render(this.engine.scene, this.engine.camera);
    this.engine.renderer.__gl.endFrameEXP?.();
  };

  static CAR_VARIANTS = 8;
  static LOG_VARIANTS = 4;
}
