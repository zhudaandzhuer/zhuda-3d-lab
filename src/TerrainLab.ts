import {
  ZhudaEngine,
  ZhudaTerrain2D,
  ZhudaTerrain2DRenderer,
  ZhudaHeightfield,
  ZhudaTerrain3D,
  ZhudaShaderMaterial,
  shaderRecipes,
  ZhudaCameraRig,
  ZhudaCameraCoordinates,
  ZhudaSceneQueries,
  ZhudaPointerInput,
  createSurfaceMaterial,
  createSurfaceTexture,
  disposeSurfaceMaterial,
  inspectSceneResources,
  sceneQuality,
  applySceneQuality,
  ZhudaRuntimeProfiler,
} from "zhuda-laya-engine";
export async function terrainMain() {
  const L = (globalThis as any).Laya,
    $ = (id: string) => document.getElementById(id)!,
    q = new URLSearchParams(location.search),
    send = (type: string, state?: unknown) =>
      parent.postMessage({ type, state }, "*");
  let time = 0,
    mode: 2 | 3 = 3,
    stride: 1 | 2 | 4 = 1,
    quality = q.get("quality") || "medium",
    selected = "",
    input: ZhudaPointerInput | undefined;
  let ctx: any;
  const snapshot = () => ({
    time,
    mode,
    stride,
    quality,
    underground,
    field: field.toJSON(),
    tiles: tiles.toJSON(),
  });
  ctx = await ZhudaEngine.boot({
    container: $("viewport"),
    features: ["core", "3d"],
    dprCap: quality === "low" ? 1 : 1.5,
    antialias: false,
    preserveDrawingBuffer: false,
    clearInput: () => input?.clear(),
    onContextLost: () => send("zhuda:context-lost", snapshot()),
  });
  const scene = new L.Scene3D();
  ctx.rootScene.addChild(scene);
  scene.ambientMode = L.AmbientMode.SolidColor;
  scene.ambientColor = new L.Color(0.6, 0.6, 0.6, 1);
  scene.enableFog = true;
  scene.fogColor = new L.Color(0.12, 0.2, 0.25, 1);
  scene.fogStart = 50;
  scene.fogRange = 100;
  const camera = new L.Camera(0, 0.1, 300);
  scene.addChild(camera);
  camera.clearColor = new L.Color(0.12, 0.2, 0.25, 1);
  camera.fieldOfView = 55;
  const lightNode = new L.Sprite3D();
  scene.addChild(lightNode);
  const sun = lightNode.addComponent(L.DirectionLightCom);
  lightNode.transform.rotationEuler = new L.Vector3(-45, -30, 0);
  const rig = new ZhudaCameraRig(camera, { minDistance: 8, maxDistance: 120 });
  rig.distance = 74;
  rig.yaw = 0.4;
  rig.pitch = 0.8;
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
  const rockShader = new ZhudaShaderMaterial({
      ...shaderRecipes.terrain3D,
      name: "ZhudaTerrainRockShell",
      uniforms: {
        ...shaderRecipes.terrain3D.uniforms,
        u_ZhudaGrass: { type: "vec3", value: [0.22, 0.15, 0.12] },
        u_ZhudaRock: { type: "vec3", value: [0.36, 0.25, 0.18] },
        u_ZhudaSnowLine: { type: "float", value: 100 },
      },
    }),
    terrainShader = new ZhudaShaderMaterial(shaderRecipes.terrain3D),
    tint = new ZhudaShaderMaterial(shaderRecipes.tint2D),
    dissolve = new ZhudaShaderMaterial(shaderRecipes.dissolve3D);
  const pixels = new Uint8Array(8 * 4 * 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++)
      pixels.set(
        x < 4 ? [48, 160, 72, 255] : [232, 184, 88, 255],
        (y * 8 + x) * 4,
      );
  const atlasData = createSurfaceTexture(8, 4, pixels, "color"),
    atlas = new L.Texture(atlasData);
  atlasData.filterMode = L.FilterMode.Point;
  const textured = new ZhudaShaderMaterial(shaderRecipes.textured3D, {
    u_ZhudaTexture: atlasData,
  });
  const noFog = new ZhudaShaderMaterial(
    { ...shaderRecipes.textured3D, name: "ZhudaNoFogFixture", fog: false },
    { u_ZhudaTexture: atlasData },
  );
  let field = ZhudaHeightfield.generate({
    cellsX: 64,
    cellsZ: 64,
    cellSize: 1,
    origin: [-32, -32],
    seed: 240,
    amplitude: 8,
    frequency: 0.1,
  });
  const palette = [
    {
      id: 1,
      uv: [0.0625, 0.125, 0.4375, 0.875] as [number, number, number, number],
    },
    {
      id: 2,
      uv: [0.5625, 0.125, 0.9375, 0.875] as [number, number, number, number],
    },
    { id: 3, color: "#4488cc", blocked: true },
  ];
  let tiles = new ZhudaTerrain2D({
    schemaVersion: 1,
    dimension: 2,
    width: 128,
    height: 64,
    tileSize: 20,
    palette,
    layers: [
      {
        id: "ground",
        tiles: Array.from({ length: 128 * 64 }, (_, i) =>
          Math.floor(i / 128) % 9 === 4 || i % 13 === 5 ? 2 : 1,
        ),
      },
      { id: "build", tiles: Array(128 * 64).fill(0) },
    ],
  });
  let terrain = new ZhudaTerrain3D(field, {
      parent: scene,
      material: terrainShader.material,
      solid: { depth: 12, material: rockShader.material },
      chunkCells: 32,
      maxResidentChunks: 4,
    }),
    map = new ZhudaTerrain2DRenderer(tiles, {
      parent: ctx.rootScene,
      atlas,
      material: tint.material,
      chunkCells: 16,
      maxResidentChunks: 20,
    });
  const full = { minX: -32, minZ: -32, maxX: 32, maxZ: 32 };
  terrain.setRegion(full);
  const queries = new ZhudaSceneQueries();
  let off = queries.register(terrain.queryProvider("terrain", 4));
  const collision = { queries, radius: 0.5, clearance: 0.3, layerMask: 4 };
  let underground = false;
  rig.options.collision = collision;
  const setUnderground = (value: boolean) => {
    underground = value;
    rig.options.collision = value ? undefined : collision;
    rig.pitch = value ? -0.5 : 0.8;
    $("underground").textContent = value ? "返回地上／防穿透" : "地下檢視";
  };
  const pbr = createSurfaceMaterial({
      type: "pbr",
      color: [0.7, 0.3, 0.14, 1],
      roughness: 0.4,
      metallic: 0.2,
    }),
    unlit = createSurfaceMaterial({ type: "unlit", color: [0.2, 0.7, 0.9, 1] });
  const mesh = L.PrimitiveMesh.createBox(4, 4, 4),
    nodes: any[] = [];
  for (const [i, material] of [
    pbr,
    unlit,
    textured.material,
    dissolve.material,
  ].entries()) {
    const n = new L.MeshSprite3D(mesh, "shader-fixture-" + i);
    n.meshRenderer.sharedMaterial = material;
    n.transform.position = new L.Vector3(
      -12 + i * 8,
      field.sample(-12 + i * 8, 0)!.height + 3,
      0,
    );
    scene.addChild(n);
    nodes.push(n);
  }
  const setQuality = (value: string) => {
    quality = value in sceneQuality ? value : "medium";
    applySceneQuality(
      sceneQuality[quality as keyof typeof sceneQuality],
      ctx.runtime,
      camera,
      [sun],
    );
  };
  setQuality(quality);
  let scroll = 0,
    animate = false,
    lastSend = 0;
  const samples: number[] = [];
  const sampleModes: (2 | 3)[] = [];
  const sampleModeFrames = { 2: 0, 3: 0 };
  const modeFrames = { 2: 0, 3: 0 };
  let sampleCursor = 0,
    excludedGaps = 0,
    totalFrames = 0;
  const profiler = new ZhudaRuntimeProfiler();
  profiler.attach(
    ctx.canvas.getContext("webgl2") || ctx.canvas.getContext("webgl"),
  );
  profiler.beginFrame();
  let drawCalls = 0,
    triangles = 0;
  const started = performance.now();
  let last = started;
  const view = () => {
    const r = ctx.canvas.getBoundingClientRect(),
      dpr = ctx.canvas.width / r.width;
    map.root.scale(dpr, dpr);
    map.root.pos((20 - scroll) * dpr, 80 * dpr);
    map.setView({
      x: scroll,
      y: 0,
      width: Math.min(r.width - 40, 1500),
      height: Math.min(r.height - 120, 1000),
    });
  };
  const setMode = (value: 2 | 3) => {
    mode = value;
    scene.active = value === 3;
    map.root.visible = value === 2;
    view();
  };
  setMode(3);
  const brush = () => {
    field.brush(0, 0, 6, 1.2);
    terrain.flush();
  };
  const paint = () => {
    tiles.paintRect("build", { x: 15, y: 5, width: 3, height: 3 }, 3);
    map.flush();
  };
  const changeStride = (value: 1 | 2 | 4) => {
    stride = value;
    terrain.setRegion(full, value);
  };
  const rebuild = (state: any) => {
    terrain.dispose();
    map.dispose();
    off();
    field = new ZhudaHeightfield(state.field);
    tiles = new ZhudaTerrain2D(state.tiles);
    terrain = new ZhudaTerrain3D(field, {
      parent: scene,
      material: terrainShader.material,
      solid: { depth: 12, material: rockShader.material },
      chunkCells: 32,
      maxResidentChunks: 4,
    });
    map = new ZhudaTerrain2DRenderer(tiles, {
      parent: ctx.rootScene,
      atlas,
      material: tint.material,
      chunkCells: 16,
      maxResidentChunks: 20,
    });
    off = queries.register(terrain.queryProvider("terrain", 4));
    time = state.time || 0;
    changeStride(state.stride || 1);
    setQuality(state.quality || quality);
    setMode(state.mode === 2 ? 2 : 3);
    setUnderground(state.underground === true);
  };
  const actions = (type: string, state: any) => {
    if (type === "lab:underground") setUnderground(!underground);
    if (type === "lab:weather") brush();
    if (type === "lab:route") paint();
    if (type === "lab:preview") setMode(mode === 2 ? 3 : 2);
    if (type === "lab:quality") setQuality(state);
    if (type === "zhuda:restore" && state?.field) rebuild(state);
  };
  window.addEventListener("message", (e) => {
    if (e.source === parent) actions(e.data?.type, e.data?.state);
  });
  input = new ZhudaPointerInput(
    ctx.canvas,
    () => (mode === 3 ? "look" : null),
    (states) => {
      for (const p of states.values()) {
        rig.rotate(p.dx, p.dy);
        p.dx = p.dy = 0;
      }
    },
  );
  ctx.canvas.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();
      if (mode === 3) rig.zoom(e.deltaY);
      else {
        scroll = Math.max(0, Math.min(900, scroll + e.deltaY));
        view();
      }
    },
    { passive: false },
  );
  ctx.canvas.addEventListener("click", (e: MouseEvent) => {
    if (mode === 3) {
      const h = queries.raycast(
        coords.screenToRay(e.clientX, e.clientY),
        300,
        4,
      );
      selected = h?.instanceId?.toString() || "";
    } else {
      const r = ctx.canvas.getBoundingClientRect(),
        p = tiles.localToTile(
          e.clientX - r.left - 20 + scroll,
          e.clientY - r.top - 80,
        );
      if (p) {
        tiles.setTile(
          "build",
          p.col,
          p.row,
          tiles.getTile("build", p.col, p.row) ? 0 : 3,
        );
        map.flush();
        selected = p.col + ":" + p.row;
      }
    }
  });
  const undergroundButton = document.createElement("button");
  undergroundButton.id = "underground";
  undergroundButton.textContent = "地下檢視";
  document.querySelector("header nav")!.appendChild(undergroundButton);
  undergroundButton.onclick = () => setUnderground(!underground);
  $("label").hidden = true;
  $("hit").textContent = "LOD 1 → 2 → 4";
  $("hit").onclick = () =>
    changeStride(stride === 1 ? 2 : stride === 2 ? 4 : 1);
  $("controls").textContent = "拖曳轉向／點選地形 · 2D 點選繪製／滾輪捲動";
  const metrics = () => {
    const s = [...samples].sort((a, b) => a - b),
      at = (p: number) => s[Math.max(0, Math.ceil(s.length * p) - 1)] || 0;
    return {
      id: q.get("id") || "terrain-browser",
      ready: true,
      elapsedSeconds: (performance.now() - started) / 1000,
      activeSeconds: samples.reduce((a, b) => a + b, 0) / 1000,
      frames: samples.length,
      sampleWindow:
        "Latest at most 72000 intervals under 5000ms; long gaps excluded",
      sampleModeFrames: { ...sampleModeFrames },
      totalFrames,
      excludedGaps,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      longFrames: samples.filter((x) => x > 50).length,
      gpuTimeMs: null,
      gpuTimeReason: "GPU timer unavailable / not collected",
      drawCalls,
      triangles,
      quality,
      dpr: ctx.canvas.width / ctx.canvas.getBoundingClientRect().width,
      mode,
      modeFrames,
      route: q.has("route"),
      underground,
      cameraCollision: !underground,
      terrain: terrain.report(),
      mapChunks: map.residentChunks,
      resources: inspectSceneResources(),
      userAgent: navigator.userAgent,
    };
  };
  const lifecycle = async () => {
    const counts = [];
    for (let i = 0; i < 30; i++) {
      const shader = new ZhudaShaderMaterial(shaderRecipes.terrain3D),
        t = new ZhudaTerrain3D(field, {
          parent: scene,
          material: shader.material,
          chunkCells: 32,
          maxResidentChunks: 4,
        }),
        m = new ZhudaTerrain2DRenderer(tiles, {
          parent: ctx.rootScene,
          atlas,
          material: tint.material,
          maxResidentChunks: 20,
        });
      t.setRegion(full);
      m.setView({ x: 0, y: 0, width: 500, height: 300 });
      await new Promise((r) => requestAnimationFrame(r));
      t.dispose();
      m.dispose();
      shader.dispose();
      L.Resource.destroyUnusedResources(false);
      await new Promise((r) => requestAnimationFrame(r));
      counts.push(inspectSceneResources());
    }
    return counts;
  };
  const invalidShaderFixture = () => {
    const bad = new ZhudaShaderMaterial({
        ...shaderRecipes.tint2D,
        name: "ZhudaInvalidGLSLFixture",
        surface:
          "vec4 zhudaSurface(vec2 uv,vec4 c){return ZHUDA_UNDEFINED_COMPILE_TEST;}",
      }),
      s = new L.Sprite();
    s.graphics.material = bad.material;
    s.graphics.drawRect(0, 0, 30, 30, "#ffffff");
    ctx.rootScene.addChild(s);
    return true;
  };
  const api: any = {
    lifecycle,
    setUnderground,
    rockShader,
    noFog,
    invalidShaderFixture,
    ready: true,
    ctx,
    scene,
    camera,
    coords,
    queries,
    rig,
    terrainShader,
    tint,
    dissolve,
    textured,
    atlas,
    atlasData,
    nodes,
    metrics,
    snapshot,
    actions,
    brush,
    paint,
    changeStride,
    setMode,
    stream: (x: number) => {
      scroll = x;
      view();
    },
    animate: (v: boolean) => (animate = v),
    restore: rebuild,
    lose: () =>
      ctx.canvas
        .getContext("webgl2")
        .getExtension("WEBGL_lose_context")
        .loseContext(),
  };
  Object.defineProperties(api, {
    terrain: { get: () => terrain },
    field: { get: () => field },
    map: { get: () => map },
    tiles: { get: () => tiles },
  });
  (window as any).terrainLab = api;
  ctx.runtime.start((dt: number) => {
    time += dt;
    if (q.has("route")) {
      const next: 2 | 3 = Math.floor(time / 30) % 2 === 0 ? 3 : 2;
      if (next !== mode) setMode(next);
      rig.yaw = time * 0.06;
      scroll = (time * 16) % 900;
      animate = true;
    }

    rig.update({ x: 0, y: (field.sample(0, 0)?.height ?? 0) + 2, z: 0 });
    const now = performance.now(),
      ms = now - last;
    last = now;
    const frame = profiler.endFrame(ms, 0);
    drawCalls = frame.drawCalls;
    triangles = frame.triangles;
    profiler.beginFrame();
    if (dt > 0 && ms < 5000) {
      modeFrames[mode]++;
      totalFrames++;
      if (samples.length < 72000) {
        samples.push(ms);
        sampleModes.push(mode);
      } else {
        sampleModeFrames[sampleModes[sampleCursor]]--;
        samples[sampleCursor] = ms;
        sampleModes[sampleCursor] = mode;
        sampleCursor = (sampleCursor + 1) % 72000;
      }
      sampleModeFrames[mode]++;
    } else if (ms >= 5000) {
      excludedGaps++;
    }
    if (animate)
      dissolve.setUniform("u_ZhudaAmount", 0.45 + 0.35 * Math.sin(time));
    if (mode === 2) view();
    $("status").textContent =
      `${mode === 3 ? (underground ? "3D 封閉地形 · 地下檢視" : "3D 封閉地形 · 相機防穿透") : "2D 分塊地圖"} · ${quality}\n${terrain.report().renderMeshes} meshes · ${map.residentChunks} tile chunks · LOD ${stride}\n${selected || "點選取得穩定 cell ID"}`;
    if (now - lastSend > 15000) {
      lastSend = now;
      const r = metrics();
      send("zhuda:metrics", r);
      send("zhuda:snapshot", snapshot());
      if (q.has("id"))
        fetch("/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(r),
        }).catch(() => {});
    }
  });
  send("zhuda:ready");
}
