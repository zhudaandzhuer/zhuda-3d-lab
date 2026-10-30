import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const root = path.resolve(import.meta.dirname, ".."),
  evidence = path.resolve(process.env.EVIDENCE_DIR || path.join(root, "evidence")),
  url = process.env.GAME_URL || "http://localhost:8916/zhuda-3d-lab/";
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zhuda-terrain-")),
  checks = [],
  errors = [],
  failures = [];
let server, socket, chrome;
try {
  if (!process.env.GAME_URL) {
    server = spawn(process.execPath, ["scripts/server.mjs"], {
      cwd: root,
      env: { ...process.env, PORT: "8916", BASE_PATH: "/zhuda-3d-lab" },
      stdio: "ignore",
    });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(url)).ok) break;
      } catch {}
      await delay(100);
    }
  }
  chrome = spawn(
    process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--window-size=1280,850",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0],
    targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
  socket = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error
        ? p?.reject(Error(JSON.stringify(m.error)))
        : p?.resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown")
      errors.push(m.params.exceptionDetails);
    else if (
      m.method === "Runtime.consoleAPICalled" &&
      (m.params.type === "error" ||
        m.params.args.some((a) =>
          String(a.value || "").includes("ShaderCompile"),
        ))
    )
      errors.push(m.params.args.map((a) => a.value || a.description));
    else if (m.method === "Network.loadingFailed" && !m.params.canceled)
      failures.push(m.params.errorText);
    else if (
      m.method === "Network.responseReceived" &&
      m.params.response.status >= 400 &&
      !m.params.response.url.endsWith("/favicon.ico")
    )
      failures.push(m.params.response.url + ":" + m.params.response.status);
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      socket.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expression) => {
    const r = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 300; i++) {
      if (errors.length) throw Error(JSON.stringify(errors));
      if (await ev(expression)) return;
      await delay(100);
    }
    throw Error("Timed out " + expression);
  };
  const shot = async (name) => {
    await delay(150);
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(evidence, name + ".png"),
      Buffer.from(r.data, "base64"),
    );
    return r.data;
  };
  const pixel = async (x, y) => {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    return ev(
      `new Promise(resolve=>{const i=new Image();i.onload=()=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);resolve([...g.getImageData(${x},${y},1,1).data])};i.src='data:image/png;base64,${r.data}'})`,
    );
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Page.navigate", { url: url + "?terrain=1" });
  const A = "labHost.frame.contentWindow.terrainLab";
  await wait("window.labHost?.frame?.contentWindow?.terrainLab?.ready");
  await delay(300);
  await shot("05-terrain-3d");
  const rendered = await ev(A + ".metrics()");
  assert.ok(rendered.drawCalls > 0 && rendered.triangles > 0);
  assert.equal(rendered.sampleModeFrames[2] + rendered.sampleModeFrames[3], rendered.frames);
  checks.push({ name: "real terrain meshes and four shader fixtures render", drawCalls: rendered.drawCalls, triangles: rendered.triangles });
  const edits = await ev(
    `(()=>{const a=${A};a.brush();const left=a.terrain.chunkSnapshot('0:0'),right=a.terrain.chunkSnapshot('1:0'),other=a.terrain.chunkSnapshot('0:1');let maxError=0;for(let j=0;j<left.zs.length;j++){const li=(j*left.xs.length+left.xs.length-1)*8,ri=j*right.xs.length*8;for(let k=0;k<6;k++)maxError=Math.max(maxError,Math.abs(left.vertices[li+k]-right.vertices[ri+k]));}const p=a.field.sample(0,0),h=a.queries.raycast({origin:{x:0,y:40,z:0},direction:{x:0,y:-1,z:0}});return{maxError,height:p.height,hit:h.position.y,id:h.instanceId}})()`,
  );
  assert.equal(edits.maxError, 0);
  assert.ok(Math.abs(edits.height - edits.hit) < 1e-5);
  assert.ok(edits.id);
  checks.push({
    name: "edited chunk seams, normals and exact triangle queries",
    ...edits,
  });
  for (const stride of [1, 2, 4]) {
    const lod = await ev(
      `(()=>{const a=${A};a.changeStride(${stride});const p=a.terrain.sampleLocal(.7,.3),h=a.terrain.raycast({origin:{x:.7,y:40,z:.3},direction:{x:0,y:-1,z:0}});return{...a.terrain.report(),error:Math.abs(h.position.y-p.height)}})()`,
    );
    assert.ok(lod.error < 1e-5);
    checks.push({ name: "LOD " + stride + " has matching queries", ...lod });
  }
  await ev(A + ".changeStride(1)");
  const transformed = await ev(
    `(()=>{const a=${A},L=labHost.frame.contentWindow.Laya,t=a.terrain.root.transform;t.localScale=new L.Vector3(1.4,1.8,.7);t.rotationEuler=new L.Vector3(12,31,8);t.position=new L.Vector3(3,1,-2);const p=a.field.sample(.3,.8),local=new L.Vector3(.3,p.height,.8),above=new L.Vector3(.3,p.height+10,.8),world=new L.Vector3(),origin=new L.Vector3();L.Vector3.transformCoordinate(local,t.worldMatrix,world);L.Vector3.transformCoordinate(above,t.worldMatrix,origin);const direction={x:world.x-origin.x,y:world.y-origin.y,z:world.z-origin.z},expectedDistance=Math.hypot(direction.x,direction.y,direction.z),hit=a.terrain.raycast({origin,direction}),error=Math.hypot(hit.position.x-world.x,hit.position.y-world.y,hit.position.z-world.z),distanceError=Math.abs(hit.distance-expectedDistance),limited=a.terrain.raycast({origin,direction},expectedDistance-.01);t.localScale=new L.Vector3(1,1,1);t.rotationEuler=new L.Vector3();t.position=new L.Vector3();return{error,distanceError,limited}})()`,
  );
  assert.ok(transformed.error < 1e-4);
  assert.ok(transformed.distanceError < 1e-4);
  assert.equal(transformed.limited, null);
  checks.push({
    name: "terrain ray with rotated, nonuniform world transform",
    ...transformed,
  });
  const stream = await ev(
    `(()=>{const a=${A};a.terrain.setRegion({minX:-32,minZ:-32,maxX:0,maxZ:0});const count=a.terrain.report().residentChunks,unloaded=a.terrain.raycast({origin:{x:20,y:40,z:20},direction:{x:0,y:-1,z:0}});a.terrain.setRegion({minX:-32,minZ:-32,maxX:32,maxZ:32});return{count,unloaded}})()`,
  );
  assert.equal(stream.count, 1);
  assert.equal(stream.unloaded, null);
  checks.push({
    name: "3D region unload excludes nonresident query cells",
    ...stream,
  });
  await ev(A + ".setMode(2)");
  await delay(200);
  const point = await ev(
      `(()=>{const r=labHost.frame.getBoundingClientRect();return{x:70,y:r.top+130}})()`,
    ),
    original = await pixel(point.x, point.y);
  await ev(A + `.tint.setUniform('u_ZhudaTint',[0,0,0,1])`);
  await delay(150);
  const black = await pixel(point.x, point.y);
  assert.ok(Math.max(...original.slice(0, 3)) > 40);
  assert.ok(Math.max(...black.slice(0, 3)) < 8);
  await ev(A + `.tint.setUniform('u_ZhudaTint',[1,1,1,1])`);
  checks.push({
    name: "2D atlas shader uniform changes actual output pixels",
    original,
    black,
  });
  await delay(100);
  const atlasSecond = await pixel(210, point.y);
  assert.ok(atlasSecond[0] > atlasSecond[1] && atlasSecond[1] > atlasSecond[2]);
  assert.ok(original[1] > original[0]);
  await ev(`(()=>{const a=${A},L=labHost.frame.contentWindow.Laya;a.map.root.scrollRect=new L.Rectangle(0,0,10,10)})()`);
  await delay(150);
  const clipped = await pixel(point.x, point.y);
  assert.notDeepEqual(clipped, original);
  assert.ok(Math.max(...clipped.slice(0,3)) < 40);
  await ev(A + ".map.root.scrollRect=null");
  checks.push({ name: "2D atlas UV regions and graphics scrollRect clipping", atlasSecond, clipped });
  const tiles = await ev(
    `(()=>{const a=${A};a.paint();const before=a.map.residentChunks;a.stream(900);const far=a.map.residentChunks;a.stream(0);return{before,far,blocked:a.tiles.isBlocked(16,6),id:a.tiles.getTile('build',16,6)}})()`,
  );
  assert.equal(tiles.blocked, true);
  assert.equal(tiles.id, 3);
  assert.ok(tiles.before <= 20 && tiles.far <= 20);
  await shot("06-terrain-2d");
  checks.push({
    name: "2D atlas/solid layers, boundary paint and bounded chunk streaming",
    ...tiles,
  });
  const alpha = await ev(
    `(()=>{const a=${A};a.tint.setUniform('u_ZhudaTint',[1,1,1,.5]);return a.tint.report()})()`,
  );
  await delay(100);
  const half = await pixel(point.x, point.y);
  assert.notDeepEqual(half, original);
  await ev(A + `.tint.setUniform('u_ZhudaTint',[1,1,1,1])`);
  checks.push({ name: "2D premultiplied alpha uniform", half, alpha });
  await ev(A + ".setMode(3)");
  await ev(A + ".scene.enableFog=false");
  await delay(150);
  const texturePoint = await ev(`(()=>{const a=${A},p=a.coords.worldToScreen(a.nodes[2].transform.position),r=labHost.frame.getBoundingClientRect();return{x:Math.round(p.x+r.left),y:Math.round(p.y+r.top)}})()`);
  const textureBefore = await pixel(texturePoint.x, texturePoint.y);
  await ev(A + `.textured.setUniform('u_ZhudaTint',[0,0,0,1])`);
  await delay(150);
  const textureBlack = await pixel(texturePoint.x, texturePoint.y);
  assert.ok(Math.max(...textureBefore.slice(0,3)) > 40);
  assert.ok(Math.max(...textureBlack.slice(0,3)) < 8);
  await ev(A + `.textured.setUniform('u_ZhudaTint',[1,1,1,1])`);
  await ev(A + ".scene.enableFog=true");
  await delay(150);
  const foggedTexture = await pixel(texturePoint.x, texturePoint.y);
  assert.notDeepEqual(foggedTexture, textureBefore);
  checks.push({name: "3D sRGB texture recipe, typed uniform and fog variants change actual output pixels", textureBefore, textureBlack, foggedTexture});
  await ev(A + `.dissolve.setUniform('u_ZhudaAmount',0)`);
  const visible = await shot("07-shader-visible");
  await ev(A + `.dissolve.setUniform('u_ZhudaAmount',1)`);
  const hidden = await shot("08-shader-dissolved");
  assert.notEqual(visible, hidden);
  checks.push({ name: "3D dissolve changes rendered image" });
  const cycles = await ev(A + ".lifecycle()");
  assert.ok(
    Math.max(...cycles.slice(5).map((x) => x.resources)) -
      Math.min(...cycles.slice(5).map((x) => x.resources)) <=
      2,
  );
  assert.equal(await ev(A + ".atlasData.destroyed"), false);
  checks.push({
    name: "30 terrain, shader and 2D chunk disposal cycles",
    first: cycles[0],
    last: cycles.at(-1),
  });
  const g = await ev("labHost.generation");
  await ev(A + ".lose()");
  await wait(
    `labHost.generation>${g}&&labHost.frame.contentWindow.terrainLab?.ready&&labHost.frame.contentWindow.terrainLab.tiles.getTile("build",16,6)===3`,
  );
  assert.equal(await ev(A + '.tiles.getTile("build",16,6)'), 3);
  checks.push({ name: "terrain edits restore after actual context loss" });
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await delay(250);
  await ev(A + ".ctx.resize()");
  await ev(A + ".setMode(2)");
  await delay(150);
  await shot("09-terrain-mobile");
  assert.ok((await ev(A + ".map.residentChunks")) <= 20);
  checks.push({ name: "mobile DPR cap with 2D terrain shader" });
  await ev(A + ".invalidShaderFixture()");
  await delay(300);
  const expectedErrors = errors.splice(0);
  assert.ok(
    JSON.stringify(expectedErrors).includes("ZHUDA_UNDEFINED_COMPILE_TEST"),
  );
  checks.push({
    name: "invalid GLSL generates actual compile diagnostics",
    expectedDiagnostics: expectedErrors,
  });
  await cdp("Page.navigate", { url: url + "?terrain=1&sandbox=1" });
  await wait("window.latest?.ready&&latest.terrain?.residentChunks===4");
  checks.push({ name: "terrain and shader load in opaque-origin iframe" });
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  fs.writeFileSync(
    path.join(evidence, "terrain-report.json"),
    JSON.stringify(
      {
        sourceURL: url,
        checks,
        errors,
        failures,
        metrics: await ev("latest"),
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks: checks.length, errors, failures }, null, 2),
  );
} catch (e) {
  fs.writeFileSync(
    path.join(evidence, "terrain-partial.json"),
    JSON.stringify({ checks, errors, failures }, null, 2),
  );
  console.error(e);
  process.exitCode = 1;
} finally {
  socket?.close();
  chrome?.kill("SIGTERM");
  server?.kill("SIGTERM");
}
