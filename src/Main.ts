import { terrainMain } from "./TerrainLab";
import {
  Zhuda3D,
  ZhudaEngine,
  ZhudaRuntimeHost,
  ZhudaModelLibrary,
  ZhudaDynamicMesh,
  createSurfaceMaterial,
  disposeSurfaceMaterial,
  createCustomSurfaceMaterial,
  ZhudaInstanceGroup,
  ZhudaSceneQueries,
  rayBox,
  ZhudaCameraCoordinates,
  ZhudaPointerInput,
  ZhudaCameraRig,
  ZhudaRuntimeProfiler,
  ZhudaSceneBudget,
  ZhudaResourceScope,
  ZhudaSurfaceQuery,
  compose4,
  ZhudaEffectDirector,
  inspectSceneResources,
  applySceneQuality,
  sceneQuality,
  configureSurfacePasses,
} from "zhuda-laya-engine";
import { sampleWave, WAVE_GLSL, SEA_LEVEL } from "./WaveField.js";
import { vertex, fragment } from "./OceanShader.js";
const q = new URLSearchParams(location.search),
  $ = (id: string) => document.getElementById(id)!,
  L = (globalThis as any).Laya;
const fail = (error: unknown) => {
  $("fatal").hidden = false;
  $("fatal").textContent = String(error);
  console.error(error);
  if (parent !== window)
    parent.postMessage({ type: "lab:error", state: String(error) }, "*");
};
window.addEventListener("unhandledrejection", (e) => fail(e.reason));
window.addEventListener("error", (e) => {
  if (e.error) fail(e.error);
});
if (!q.has("runtime")) {
  if (q.has("terrain")) {
    document.querySelector("h1")!.textContent = "豬大地形工坊";
    document.querySelector("[data-action=weather]")!.textContent = "抬高地形";
    document.querySelector("[data-action=route]")!.textContent = "圖塊筆刷";
    document.querySelector("[data-action=preview]")!.textContent = "2D / 3D";
  }
  document.body.className = "host";
  ($("quality") as HTMLSelectElement).value = q.get("quality") || "medium";
  let preview: ZhudaRuntimeHost | undefined;
  const host = new ZhudaRuntimeHost(
    $("viewport"),
    location.pathname + "?runtime=1&" + q.toString(),
    {
      sandbox: q.has("sandbox") ? "allow-scripts" : undefined,
      onMessage: (m) => {
        (window as any).lastMessage = m;
        if (m.type === "lab:error") fail(m.state);
        if (m.type === "zhuda:metrics") (window as any).latest = m.state;
      },
    },
  );
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(
    (b) =>
      (b.onclick = () => {
        if (b.dataset.action === "preview" && !q.has("terrain")) {
          $("preview").hidden = false;
          preview?.dispose();
          preview = new ZhudaRuntimeHost(
            $("preview-frame"),
            location.pathname + "?runtime=preview",
          );
        } else host.send("lab:" + b.dataset.action);
      }),
  );
  $("close-preview").onclick = () => {
    preview?.dispose();
    preview = undefined;
    $("preview").hidden = true;
  };
  $("quality").onchange = () =>
    host.send("lab:quality", ($("quality") as HTMLSelectElement).value);
  (window as any).labHost = host;
} else {
  document.body.className = "runtime";
  (q.has("terrain") ? terrainMain() : main()).catch(fail);
}
async function main() {
  const preview = q.get("runtime") === "preview",
    scope = new ZhudaResourceScope(),
    library = new ZhudaModelLibrary(3),
    queries = new ZhudaSceneQueries(),
    budget = new ZhudaSceneBudget();
  let time = 0,
    weather = false,
    route = q.has("route"),
    energy = 1,
    quality = q.get("quality") || "medium",
    selected = "",
    ready = false;
  const motion = { x: 0, z: 0 },
    target = { x: 0, y: 0.2, z: 0 },
    samples: { ms: number; drawCalls: number; triangles: number }[] = [],
    started = performance.now();
  let last = performance.now(),
    lastSend = 0,
    interruptions = 0;
  const snapshot = () => ({
    time,
    weather,
    route,
    target: { ...target },
    quality,
  });
  const post = (type: string, state?: unknown) =>
    parent.postMessage({ type, state }, "*");
  let input: ZhudaPointerInput | undefined;
  const ctx = await ZhudaEngine.boot({
    container: $("viewport"),
    features: ["core", "3d", "gltf"],
    antialias: false,
    preserveDrawingBuffer: false,
    dprCap: quality === "low" ? 1 : quality === "high" ? 2 : 1.5,
    targetFPS: 60,
    clearInput: () => {
      motion.x = motion.z = 0;
      input?.clear();
    },
    onPause: (p) => {
      if (p) interruptions++;
    },
    onContextLost: () => post("zhuda:context-lost", snapshot()),
  });
  const scene = new L.Scene3D();
  ctx.rootScene.addChild(scene);
  scene.ambientMode = L.AmbientMode.SolidColor;
  scene.ambientColor = new L.Color(0.55, 0.61, 0.66, 1);
  scene.enableFog = true;
  scene.fogColor = new L.Color(0.15, 0.31, 0.36, 1);
  scene.fogStart = 35;
  scene.fogRange = 95;
  const camera = new L.Camera(0, 0.1, 350);
  camera.clearColor = new L.Color(0.16, 0.32, 0.38, 1);
  camera.fieldOfView = 55;
  scene.addChild(camera);
  const rig = new ZhudaCameraRig(camera, { minDistance: 5, maxDistance: 65 });
  rig.yaw = 0.45;
  rig.pitch = 0.55;
  rig.distance = preview ? 4.4 : 23;
  const { light: sun } = Zhuda3D.createDirectionalLight(scene, {
    color: [1, 0.92, 0.77, 1],
    intensity: 1.2,
    rotationEuler: [-52, -35, 0],
  });
  const setQuality = (value: string) => {
    quality = value in sceneQuality ? value : "medium";
    return applySceneQuality(
      sceneQuality[quality as keyof typeof sceneQuality],
      ctx.runtime,
      camera,
      [sun],
    );
  };
  setQuality(quality);
  const coords = new ZhudaCameraCoordinates(camera, () => {
    const r = ctx.canvas.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      backingWidth: ctx.canvas.width,
      backingHeight: ctx.canvas.height,
    };
  });
  const materials: any[] = [];
  const material = (
    color: [number, number, number, number],
    type: "pbr" | "unlit" = "pbr",
  ) => {
    const m = createSurfaceMaterial({
      type,
      color,
      roughness: 0.72,
      metallic: 0,
    });
    materials.push(m);
    return m;
  };
  const meshes: any[] = [];
  const cubeMesh = L.PrimitiveMesh.createBox(1, 1, 1);
  meshes.push(cubeMesh);
  function cube(
    name: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    m: any,
    parent = scene,
  ) {
    const n = new L.MeshSprite3D(cubeMesh, name);
    n.meshRenderer.sharedMaterial = m;
    n.transform.localPosition = new L.Vector3(x, y, z);
    n.transform.localScale = new L.Vector3(sx, sy, sz);
    parent.addChild(n);
    return n;
  }
  function grid(
    size: number,
    n: number,
    height: (x: number, z: number) => number,
  ) {
    const positions = new Float32Array((n + 1) ** 2 * 3),
      normals = new Float32Array(positions.length),
      uvs = new Float32Array((n + 1) ** 2 * 2),
      indices = new Uint16Array(n * n * 6);
    let p = 0,
      i = 0;
    for (let z = 0; z <= n; z++)
      for (let x = 0; x <= n; x++) {
        const xx = (x / n) * size - size / 2,
          zz = (z / n) * size - size / 2;
        positions.set([xx, height(xx, zz), zz], p * 3);
        const e = 0.02,
          nx = height(xx - e, zz) - height(xx + e, zz),
          nz = height(xx, zz - e) - height(xx, zz + e),
          len = Math.hypot(nx, 0.04, nz);
        normals.set([nx / len, 0.04 / len, nz / len], p * 3);
        uvs.set([x / n, z / n], p++ * 2);
      }
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const a = z * (n + 1) + x;
        indices.set([a + n + 1, a, a + n + 2, a, a + 1, a + n + 2], i);
        i += 6;
      }
    return new ZhudaDynamicMesh({ positions, normals, uvs, indices }, scene);
  }
  const terrain = grid(22, 36, (x, z) =>
    Math.max(-2, 3.7 * (1 - Math.hypot(x, z) / 10)),
  );
  terrain.node.transform.position = new L.Vector3(-12, -0.4, -5);
  terrain.node.meshRenderer.sharedMaterial = material([0.24, 0.46, 0.25, 1]);
  const water = grid(128, 144, () => 0),
    uniforms: Record<string, any> = {};
  for (const name of [
    "coopTime",
    "coopEnergy",
    "coopSurge",
    "coopFront",
    "coopShelter",
    "coopSun",
    "coopRain",
  ])
    uniforms[name] = L.ShaderDataType.Float;
  for (const name of ["coopOffset", "coopHeading", "coopCenter"])
    uniforms[name] = L.ShaderDataType.Vector2;
  uniforms.u_Island = L.ShaderDataType.Vector3;
  const ocean = createCustomSurfaceMaterial({
    name: "ConsumerOcean",
    vertex,
    fragment,
    uniforms,
  });
  materials.push(ocean);
  ocean.cull = L.RenderState.CULL_NONE;
  water.node.meshRenderer.sharedMaterial = ocean;
  water.node.transform.position = new L.Vector3(0, SEA_LEVEL, 0);
  ocean.setVector2("coopCenter", new L.Vector2(0, 0));
  ocean.setVector2("coopOffset", new L.Vector2(0, 0));
  ocean.setVector2("coopHeading", new L.Vector2(1, 0));
  ocean.setFloat("coopShelter", 2.6);
  ocean.setFloat("coopFront", -22);
  ocean.setVector3("u_Island", new L.Vector3(-12, -5, 7));
  const wood = material([0.39, 0.21, 0.08, 1]),
    dark = material([0.12, 0.19, 0.22, 1]),
    sand = material([0.67, 0.52, 0.29, 1]),
    white = material([0.74, 0.91, 0.88, 1]);
  const raft = new L.Sprite3D("raft");
  scene.addChild(raft);
  for (let z = -2; z <= 2; z++)
    cube("raft-plank", 0, 0, z * 0.7, 5, 0.25, 0.65, wood, raft);
  const boat = new L.Sprite3D("boat");
  scene.addChild(boat);
  cube("hull", 0, 0, 0, 2.1, 0.55, 4.2, dark, boat);
  cube("deck", 0, 0.3, 0, 1.8, 0.15, 3.7, wood, boat);
  cube("mast", 0, 2, 0, 0.1, 3.5, 0.1, wood, boat);
  cube("sail", 0.5, 2.2, 0, 1.1, 2, 0.07, white, boat);
  const roof = new L.Sprite3D("roof");
  scene.addChild(roof);
  cube("roof-top", 5, 3.3, -4, 4, 0.25, 4, wood, roof);
  for (const x of [3.3, 6.7])
    for (const z of [-5.7, -2.3])
      cube("pillar", x, 1.6, z, 0.15, 3.3, 0.15, wood, roof);
  const rock = cube("rock", 1, 0.5, -5, 2, 2, 2, dark);
  rock.transform.rotationEuler = new L.Vector3(0, 25, 10);
  const loot = new ZhudaInstanceGroup(scene, cubeMesh, sand);
  for (let i = 0; i < 48; i++) {
    const x = Math.sin(i * 1.7) * 18,
      z = Math.cos(i * 0.9) * 18;
    loot.set(
      "loot-" + i,
      compose4({ x, y: 0.3, z }, undefined, { x: 0.35, y: 0.35, z: 0.35 }),
    );
    queries.register({
      entityId: "resource",
      instanceId: "loot-" + i,
      layer: 2,
      raycast: (r, d) =>
        rayBox(
          r,
          { x: x - 0.3, y: -0.1, z: z - 0.3 },
          { x: x + 0.3, y: 0.8, z: z + 0.3 },
          d,
        ),
    });
  }
  queries.register({
    entityId: "rock",
    layer: 1,
    raycast: (r, d) =>
      rayBox(r, { x: 0, y: -0.5, z: -6 }, { x: 2, y: 1.5, z: -4 }, d),
  });
  const rainMat = material([0.35, 0.65, 0.84, 0.65], "unlit"),
    rain = new ZhudaInstanceGroup(scene, cubeMesh, rainMat);
  const rainCount = 160;
  const wave = (x: number, z: number, t = time) => {
    let qx = x,
      qz = z;
    let s: any;
    for (let n = 0; n < 4; n++) {
      s = sampleWave(qx, qz, t, energy, weather ? 1 : 0);
      qx = x - s.dx;
      qz = z - s.dz;
    }
    return sampleWave(qx, qz, t, energy, weather ? 1 : 0);
  };
  const surface = new ZhudaSurfaceQuery((x, z, t) => {
    const s = wave(x, z, t);
    return {
      height: s.y,
      normal: { x: s.nx, y: s.ny, z: s.nz },
      entityId: "ocean",
    };
  });
  const characters: any[] = [];
  for (const [i, skin] of [
    "navigator",
    "diver",
    "trailblazer",
    "navigator",
  ].entries()) {
    const instance = await library.instantiate(
      new URL("models/zhuda-" + skin + ".bin", location.href).href,
      { independentMaterials: true, retries: 1 },
    );
    scene.addChild(instance.node);
    instance.node.transform.localScale = new L.Vector3(1.8, 1.8, 1.8);
    instance.node.transform.position = new L.Vector3(-2 + i * 1.3, 0.2, 0);
    characters.push(instance);
  }
  const hook = cube("hook", 0, 0, 0, 0.15, 0.15, 0.4, white);
  const director = new ZhudaEffectDirector(
    {
      version: 1,
      duration: 1,
      loop: true,
      attachments: [
        {
          source: "boat",
          target: "hook",
          anchor: "mast",
          offset: { x: 0.6, y: 3.1, z: 0 },
        },
      ],
    },
    {
      boat: {
        reset() {},
        resolveAnchor: () =>
          boat.destroyed
            ? null
            : { x: 0, y: 0, worldMatrix: boat.transform.worldMatrix.elements },
      },
      hook: {
        reset() {},
        setTransform: (p) => {
          hook.transform.worldMatrix = new L.Matrix4x4(
            ...Array.from(p.worldMatrix!),
          );
        },
        stop: () => (hook.active = false),
      },
    },
  );
  input = new ZhudaPointerInput(
    ctx.canvas,
    (e) => (preview ? "look" : e.clientX < innerWidth * 0.4 ? "move" : "look"),
    (states) => {
      if (![...states.values()].some((p) => p.role === "move"))
        motion.x = motion.z = 0;
      for (const p of states.values()) {
        if (p.role === "look") {
          rig.rotate(p.dx, p.dy);
          p.dx = p.dy = 0;
        } else {
          motion.x = Math.max(-1, Math.min(1, (p.x - innerWidth * 0.2) / 90));
          motion.z = Math.max(-1, Math.min(1, (p.y - innerHeight * 0.7) / 90));
        }
      }
    },
  );
  ctx.canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      rig.zoom(e.deltaY);
    },
    { passive: false },
  );
  ctx.canvas.addEventListener("click", (e) => {
    const hit = queries.raycast(coords.screenToRay(e.clientX, e.clientY));
    selected = hit ? hit.entityId + ":" + (hit.instanceId ?? "") : "";
  });
  $("hit").onclick = () => characters[0].setTint([1, 0.08, 0.08, 1]);
  const profiler = new ZhudaRuntimeProfiler(),
    gl = ctx.canvas.getContext("webgl2") || ctx.canvas.getContext("webgl");
  profiler.attach(gl);
  for (const [id, mesh] of [
    ["ocean", water],
    ["island", terrain],
  ] as const)
    budget.track(
      id,
      "mesh",
      mesh.vertices.byteLength + mesh.data.indices.byteLength,
    );
  const resourceStats = () => {
    const map = L.Resource._idResourcesMap,
      resources =
        map instanceof Map ? [...map.values()] : Object.values(map || {});
    return {
      resources: resources.length,
      cpuBytes: L.Resource.cpuMemory,
      gpuBytesEstimated: L.Resource.gpuMemory,
      models: library.report(),
      budget: budget.report(),
      inventory: inspectSceneResources(),
    };
  };
  function report() {
    const sort = samples.map((x) => x.ms).sort((a, b) => a - b),
      at = (p: number) =>
        sort[Math.max(0, Math.ceil(sort.length * p) - 1)] ?? null;
    return {
      id: q.get("id") || "browser",
      ready,
      elapsedSeconds: (performance.now() - started) / 1000,
      activeSeconds: samples.reduce((n, x) => n + x.ms, 0) / 1000,
      frames: samples.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      longFrames: samples.filter((x) => x.ms > 50).length,
      gpuTimeMs: null,
      gpuTimeReason: "GPU timer unavailable / not collected",
      drawCalls: samples.at(-1)?.drawCalls,
      triangles: samples.at(-1)?.triangles,
      quality,
      dpr: ctx.canvas.width / ctx.canvas.getBoundingClientRect().width,
      userAgent: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight },
      population: {
        characters: 4,
        rafts: 1,
        boats: 1,
        buildings: 1,
        resources: 48,
        rain: weather ? rainCount : 0,
      },
      resources: resourceStats(),
      interruptions,
      state: snapshot(),
      selected,
    };
  }
  const actions = (type: string, state: any) => {
    if (type === "lab:weather") weather = !weather;
    if (type === "lab:route") route = !route;
    if (type === "lab:quality") setQuality(state);
    if (type === "zhuda:restore" && state) {
      time = state.time || 0;
      weather = !!state.weather;
      route = !!state.route;
      Object.assign(target, state.target || {});
      if (state.quality) setQuality(state.quality);
    }
  };
  window.addEventListener("message", (e) => {
    if (e.source === parent) actions(e.data?.type, e.data?.state);
  });
  ready = true;
  post("zhuda:ready");
  profiler.beginFrame();
  const tick = (dt: number) => {
    const now = performance.now(),
      ms = now - last;
    last = now;
    time += dt;
    energy = weather ? 1.55 : 1;
    if (dt > 0 && ms < 5000) {
      const s = profiler.endFrame(ms, 0);
      samples.push({ ms, drawCalls: s.drawCalls, triangles: s.triangles });
      if (samples.length > 72000) samples.shift();
    }
    profiler.beginFrame();
    if (route && !preview) {
      target.x = Math.sin(time * 0.075) * 12;
      target.z = Math.cos(time * 0.075) * 8;
      rig.yaw = time * 0.055 + 0.45;
      weather = Math.floor(time / 45) % 2 === 1;
    } else {
      target.x += motion.x * dt * 3;
      target.z += motion.z * dt * 3;
    }
    const s = surface.at(target.x, target.z, time)!;
    raft.transform.position = new L.Vector3(
      target.x,
      s.height + 0.18,
      target.z,
    );
    raft.transform.rotationEuler = new L.Vector3(
      (Math.atan2(s.normal.z, s.normal.y) * 180) / Math.PI,
      time * 3,
      (Math.atan2(-s.normal.x, s.normal.y) * 180) / Math.PI,
    );
    characters.forEach((c, i) => {
      const local = new L.Vector3(-1.8 + i * 1.2, 0.15, 0),
        world = new L.Vector3();
      L.Vector3.transformCoordinate(local, raft.transform.worldMatrix, world);
      c.node.transform.position = world;
      c.node.transform.rotationEuler = new L.Vector3(0, time * 3, 0);
    });
    const bs = wave(8, 4);
    boat.transform.position = new L.Vector3(8, bs.y + 0.3, 4);
    boat.transform.rotationEuler = new L.Vector3(
      bs.nz * 15,
      time * 8,
      bs.nx * 15,
    );
    director.update(dt);
    ocean.setFloat("coopTime", time);
    ocean.setFloat("coopEnergy", energy);
    ocean.setFloat("coopSurge", weather ? 1 : 0);
    ocean.setFloat("coopSun", weather ? 0.48 : 1);
    ocean.setFloat("coopRain", weather ? 1 : 0);
    scene.fogStart = weather ? 18 : 35;
    scene.fogRange = weather ? 55 : 95;
    if (weather && !preview) {
      for (let i = 0; i < rainCount; i++) {
        const x = Math.sin(i * 16.93) * 22,
          z = Math.cos(i * 7.17) * 22;
        let y = 8 - ((time * 8 + i * 0.731) % 12);
        if (x > 3 && x < 7 && z > -6 && z < -2 && y < 3.75) y = 9;
        rain.set(
          "rain-" + i,
          compose4({ x, y, z }, undefined, { x: 0.025, y: 0.5, z: 0.025 }),
        );
      }
    } else if (rain.size) rain.dispose();
    rig.update(
      preview ? { x: 0, y: 1.2, z: 0 } : { x: target.x, y: 1, z: target.z },
    );
    const pos = characters[0].node.transform.position,
      p = coords.worldToScreen({ x: pos.x, y: pos.y + 2.4, z: pos.z });
    $("label").style.left = p.x + "px";
    $("label").style.top = p.y + "px";
    $("label").hidden = !p.visible;
    $("status").textContent =
      `${weather ? "暴風雨" : "晴朗海域"} · ${quality}\n${Math.round(1000 / (ms || 16))} FPS · ${samples.at(-1)?.drawCalls || 0} draws\n${selected || "點選物資或岩石"}`;
    if (now - lastSend > 15000) {
      lastSend = now;
      const r = report();
      post("zhuda:metrics", r);
      post("zhuda:snapshot", snapshot());
      if (q.has("id"))
        fetch("/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(r),
        }).catch(() => {});
    }
  };
  if (preview) {
    terrain.node.active = false;
    water.node.active = false;
    raft.active = false;
    boat.active = false;
    roof.active = false;
    rock.active = false;
    loot.dispose();
    characters.forEach((c, i) => {
      c.node.active = i === 0;
    });
    $("hit").hidden = true;
    $("controls").textContent = "拖曳旋轉角色";
  }
  ctx.runtime.start(tick);
  const lifecycle = async (n = 30) => {
    const counts = [];
    for (let i = 0; i < n; i++) {
      const owned = new ZhudaResourceScope(),
        mesh = owned.own(L.PrimitiveMesh.createBox(1, 1, 1), (r: any) =>
          r.destroy(),
        ),
        mat = owned.own(
          createSurfaceMaterial({ type: "pbr", color: [0.4, 0.5, 0.6, 1] }),
          disposeSurfaceMaterial,
        ),
        world = owned.own(new L.Scene3D(), (s: any) => s.destroy(true));
      ctx.rootScene.addChild(world);
      const c = new L.Camera(0, 0.1, 50);
      world.addChild(c);
      c.transform.position = new L.Vector3(0, 2, 6);
      c.transform.lookAt(new L.Vector3(0, 1, 0), new L.Vector3(0, 1, 0));
      const obj = new L.MeshSprite3D(mesh);
      obj.meshRenderer.sharedMaterial = mat;
      world.addChild(obj);
      const m = await library.instantiate(
        new URL("models/zhuda-navigator.bin", location.href).href,
        { independentMaterials: true },
      );
      world.addChild(m.node);
      await new Promise((r) => requestAnimationFrame(r));
      m.dispose();
      owned.dispose();
      L.Resource.destroyUnusedResources(false);
      await new Promise((r) => requestAnimationFrame(r));
      counts.push(resourceStats());
    }
    return counts;
  };
  (window as any).lab = {
    ready,
    passes: (requirements: any[], budget: number) =>
      configureSurfacePasses(camera, requirements, budget),
    report,
    resourceStats,
    lifecycle,
    library,
    characters,
    input,
    motion,
    scene,
    camera,
    coords,
    queries,
    ctx,
    rig,
    water,
    raft,
    boat,
    hook,
    rain,
    loot,
    actions,
    wave,
    surface,
    snapshot,
    scope,
    gpuWaveCheck: () => gpuWaveCheck(gl!),
    lose: () => gl!.getExtension("WEBGL_lose_context")!.loseContext(),
  };
}
function gpuWaveCheck(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const c = document.createElement("canvas"),
    g = c.getContext("webgl2")!;
  if (!g) throw Error("WebGL2 transform feedback unavailable");
  const compile = (type: number, src: string) => {
    const s = g.createShader(type)!;
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS))
      throw Error(g.getShaderInfoLog(s) || "shader");
    return s;
  };
  const vs = compile(
    g.VERTEX_SHADER,
    "#version 300 es\nprecision highp float;\nin vec2 aPoint;out vec3 vSurface;out vec3 vNormal;" +
      WAVE_GLSL +
      "\nvoid main(){float h;oceanSurface(aPoint,vSurface,vNormal,h);gl_Position=vec4(0,0,0,1);}",
  );
  const fs = compile(
      g.FRAGMENT_SHADER,
      "#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1);}",
    ),
    p = g.createProgram()!;
  g.attachShader(p, vs);
  g.attachShader(p, fs);
  g.transformFeedbackVaryings(
    p,
    ["vSurface", "vNormal"],
    g.INTERLEAVED_ATTRIBS,
  );
  g.linkProgram(p);
  if (!g.getProgramParameter(p, g.LINK_STATUS))
    throw Error(g.getProgramInfoLog(p) || "link");
  g.useProgram(p);
  const points = new Float32Array(128);
  for (let i = 0; i < 64; i++)
    points.set([Math.sin(i * 0.7) * 22, Math.cos(i * 0.31) * 22], i * 2);
  const b = g.createBuffer()!,
    out = g.createBuffer()!;
  g.bindBuffer(g.ARRAY_BUFFER, b);
  g.bufferData(g.ARRAY_BUFFER, points, g.STATIC_DRAW);
  const a = g.getAttribLocation(p, "aPoint");
  g.enableVertexAttribArray(a);
  g.vertexAttribPointer(a, 2, g.FLOAT, false, 0, 0);
  g.bindBuffer(g.TRANSFORM_FEEDBACK_BUFFER, out);
  g.bufferData(g.TRANSFORM_FEEDBACK_BUFFER, 64 * 6 * 4, g.STREAM_READ);
  g.bindBufferBase(g.TRANSFORM_FEEDBACK_BUFFER, 0, out);
  const values = new Float32Array(64 * 6);
  let maxHeightError = 0,
    maxPositionError = 0,
    maxNormalError = 0;
  for (const time of [0, 0.7, 12.3, 99]) {
    for (const [key, v] of Object.entries({
      coopTime: time,
      coopEnergy: 1.55,
      coopSurge: 1,
      coopFront: -22,
      coopShelter: 2.6,
    }))
      g.uniform1f(g.getUniformLocation(p, key), v);
    g.uniform2f(g.getUniformLocation(p, "coopCenter"), 0, 0);
    g.uniform2f(g.getUniformLocation(p, "coopHeading"), 1, 0);
    g.enable(g.RASTERIZER_DISCARD);
    g.beginTransformFeedback(g.POINTS);
    g.drawArrays(g.POINTS, 0, 64);
    g.endTransformFeedback();
    g.disable(g.RASTERIZER_DISCARD);
    g.getBufferSubData(g.TRANSFORM_FEEDBACK_BUFFER, 0, values);
    for (let i = 0; i < 64; i++) {
      const s = sampleWave(points[i * 2], points[i * 2 + 1], time, 1.55, 1);
      maxHeightError = Math.max(
        maxHeightError,
        Math.abs(values[i * 6 + 1] + SEA_LEVEL - s.y),
      );
      maxPositionError = Math.max(
        maxPositionError,
        Math.hypot(values[i * 6] - s.x, values[i * 6 + 2] - s.z),
      );
      maxNormalError = Math.max(
        maxNormalError,
        Math.hypot(
          values[i * 6 + 3] - s.nx,
          values[i * 6 + 4] - s.ny,
          values[i * 6 + 5] - s.nz,
        ),
      );
    }
  }
  g.deleteBuffer(b);
  g.deleteBuffer(out);
  g.deleteProgram(p);
  g.deleteShader(vs);
  g.deleteShader(fs);
  g.getExtension("WEBGL_lose_context")?.loseContext();
  return {
    samples: 256,
    maxHeightError,
    maxPositionError,
    maxNormalError,
    method:
      "WebGL2 transform feedback of same WAVE_GLSL used in Laya vertex shader",
  };
}
