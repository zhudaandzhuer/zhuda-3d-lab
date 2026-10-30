import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  evidence = path.resolve(process.env.EVIDENCE_DIR || path.join(root, "evidence"));
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zhuda-arcade-qa-")),
  url = process.env.GAME_URL || "http://localhost:8915/zhuda-3d-lab/";
let server, socket;
const errors = [],
  failures = [],
  checks = [];
if (!process.env.GAME_URL) {
  server = spawn(process.execPath, ["scripts/server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: "8915", BASE_PATH: "/zhuda-3d-lab" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    await delay(100);
  }
}
const chrome = spawn(
  process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);
try {
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await delay(100);
  assert.ok(fs.existsSync(portFile));
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
    if (
      m.method === "Runtime.consoleAPICalled" &&
      m.params.type === "warning" &&
      m.params.args.some((a) => String(a.value || "").includes("ShaderCompile"))
    )
      errors.push(m.params.args.map((a) => a.value || a.description));
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error
        ? p?.reject(new Error(JSON.stringify(m.error)))
        : p?.resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown")
      errors.push(m.params.exceptionDetails);
    else if (
      m.method === "Runtime.consoleAPICalled" &&
      m.params.type === "error"
    )
      errors.push(m.params.args.map((a) => a.value || a.description));
    else if (m.method === "Network.loadingFailed" && !m.params.canceled)
      failures.push(m.params.errorText);
  };
  const cdp = (method, params = {}) =>
    new Promise((r, j) => {
      const n = ++id;
      pending.set(n, { resolve: r, reject: j });
      socket.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expression) => {
    const r = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression, seconds = 10) => {
    for (let i = 0; i < seconds * 10; i++) {
      if (errors.length) throw Error(JSON.stringify(errors));
      if (await ev(expression)) return;
      await delay(100);
    }
    throw new Error(
      "Timed out: " +
        expression +
        "\n" +
        JSON.stringify(
          await ev(
            "({generation:window.labHost?.generation,last:window.lastMessage})",
          ),
        ),
    );
  };
  const click = (id) =>
    ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  const shot = async (name) => {
    await delay(120);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(
      path.join(evidence, name + ".png"),
      Buffer.from(data, "base64"),
    );
  };
  const setViewport = (width, height, mobile = false) =>
    cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  const W = "labHost.frame.contentWindow",
    A = W + ".lab";
  const load = async (suffix = "") => {
    await cdp("Page.navigate", { url: url + suffix });
    await wait("window.labHost?.frame?.contentWindow?.lab?.ready", 30);
    await delay(250);
  };
  await setViewport(1280, 850);
  await load();
  const waves = await ev(A + ".gpuWaveCheck()");
  assert.ok(waves.maxHeightError < 0.01);
  assert.ok(waves.maxNormalError < 0.001);
  checks.push({ name: "GPU wave parity", ...waves });
  const passes = await ev(A + ".passes([{depth:true,opaqueColor:true}],2)");
  assert.equal(passes.ready, true);
  await delay(200);
  assert.equal(await ev(A + ".camera.opaquePass"), true);
  assert.ok((await ev(A + ".camera.depthTextureMode")) & 1);
  const limited = await ev(A + ".passes([{depth:true,opaqueColor:true}],0)");
  assert.equal(limited.reason, "budget");
  assert.equal(await ev(A + ".camera.opaquePass"), false);
  checks.push({
    name: "real depth/opaque camera passes and low quality budget fallback",
    passes,
    limited,
  });
  const counts = await ev(A + ".lifecycle(30)");
  assert.ok(
    Math.max(...counts.slice(5).map((x) => x.resources)) -
      Math.min(...counts.slice(5).map((x) => x.resources)) <=
      2,
  );
  assert.equal(counts.at(-1).models.instances, 4);
  checks.push({
    name: "30 model creation/destruction cycles",
    first: counts[0],
    last: counts.at(-1),
  });

  const material = await ev(
    `(()=>{const a=${A},n=a.characters[3].materials[0],m=a.characters[0].materials[0];const read=mat=>{const v=mat.getVector4('u_BaseColorFactor');return [v.x,v.y,v.z,v.w]};const before=read(n),changedBefore=read(m);a.characters[0].setTint([1,.1,.1,1]);return{different:m!==n,other:read(n),before,changedBefore,changed:read(m)}})()`,
  );
  assert.ok(material.different);
  assert.notDeepEqual(material.changed, material.changedBefore);
  assert.deepEqual(material.other, material.before);
  checks.push({
    name: "independent cloned materials, shared JPEG still live",
    material,
  });
  // GPU partial upload must update the readable buffer and the rendered mesh bounds.
  const dynamic = await ev(
    `(()=>{const a=${A},m=a.water;const old=m.vertices[1];m.setPosition(0,-64,2,-64);m.updateRange(0,1);const cpu=m.mesh.vertexBuffer.getFloat32Data()[1],bound=m.mesh.bounds.getMax().y;m.setPosition(0,-64,old,-64);m.updateRange(0,1);return{cpu,bound}})()`,
  );
  assert.equal(dynamic.cpu, 2);
  assert.equal(dynamic.bound, 2);
  checks.push({ name: "partial buffer update + bounds", dynamic });
  await ev(A + `.actions('lab:weather')`);
  await delay(500);
  assert.equal(await ev(A + ".rain.size"), 160);
  await shot("02-storm");
  const rain = await ev(
    `(()=>{const a=${A};let invalid=0;for(let i=0;i<160;i++){const p=a.rain.get('rain-'+i).transform.position;if(p.x>3&&p.x<7&&p.z>-6&&p.z<-2&&p.y-.25<3.425)invalid++}return invalid})()`,
  );
  assert.equal(rain, 0);
  checks.push({ name: "roof occludes rainfall", rain });
  for (const [width, height] of [
    [1200, 800],
    [390, 844],
    [844, 390],
  ])
    for (const dpr of [1, 2, 3]) {
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: dpr,
        mobile: width < 900,
      });
      await ev(A + ".ctx.resize()");
      await delay(120);
      const alignment = await ev(
        `(()=>{const a=${A},p=a.characters[0].node.transform.position,s=a.coords.worldToScreen(p),r=a.coords.screenToRay(s.x,s.y);const t=(p.y-r.origin.y)/r.direction.y;const miss=Math.hypot(r.origin.x+r.direction.x*t-p.x,r.origin.z+r.direction.z*t-p.z);const c=a.ctx.canvas,rect=c.getBoundingClientRect();return{miss,canvas:c.width,css:rect.width,dpr:devicePixelRatio,label:!!document.querySelector('header')}})()`,
      );
      assert.ok(alignment.miss < 0.001);
      assert.ok(
        Math.abs(alignment.canvas / alignment.css - Math.min(dpr, 1.5)) < 0.01,
      );
      checks.push({
        name: `projection/ray ${width}x${height} DPR${dpr}`,
        alignment,
      });
    }
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  await delay(150);
  const before = await ev(A + ".snapshot()");
  await cdp("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 65, y: 650, id: 1 },
      { x: 290, y: 500, id: 2 },
    ],
  });
  await cdp("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 115, y: 650, id: 1 },
      { x: 340, y: 515, id: 2 },
    ],
  });
  await delay(200);
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const after = await ev(A + ".snapshot()");
  assert.notEqual(after.target.x, before.target.x);
  const released = after.target.x;
  await delay(100);
  assert.equal((await ev(A + ".snapshot()")).target.x, released);
  checks.push({ name: "two-touch movement/rotation and release" });
  await shot("03-mobile");
  await ev(A + `.actions('lab:quality','low')`);
  const inventory = await ev(A + ".resourceStats().inventory");
  assert.ok(inventory.counts.mesh > 0 && inventory.counts.texture > 0);
  assert.equal(inventory.memoryMeasurement, "estimate");
  checks.push({
    name: "scene quality applied and logical resource inventory",
    inventory,
  });
  const generation = await ev("labHost.generation"),
    state = await ev(A + ".snapshot()");
  await ev(A + ".lose()");
  await wait(
    "labHost.generation>" +
      generation +
      "&&labHost.frame.contentWindow.lab?.ready",
    30,
  );
  assert.equal(await ev('document.querySelectorAll("main>iframe").length'), 1);
  const restored = await ev(A + ".snapshot()");
  assert.ok(restored.time >= state.time && restored.time < state.time + 3);
  assert.equal(restored.weather, state.weather);
  assert.equal(restored.quality, "low");
  assert.ok(Math.abs((await ev(A + ".report().dpr")) - 1) < 0.01);
  checks.push({
    name: "actual WEBGL_lose_context rebuild restores snapshot",
    generation: await ev("labHost.generation"),
  });
  await setViewport(1280, 850);
  await load();
  await shot("01-ocean");
  await click("close-preview");
  await ev("document.querySelector('[data-action=preview]').click()");
  await wait(
    'document.querySelector("#preview-frame iframe")?.contentWindow.lab?.ready',
    30,
  );
  assert.equal(
    await ev(
      'document.querySelector("#preview-frame iframe").contentWindow.lab.library.report().instances',
    ),
    4,
  );
  await shot("04-preview");
  await click("close-preview");
  assert.equal(
    await ev('document.querySelectorAll("#preview-frame iframe").length'),
    0,
  );
  checks.push({ name: "isolated preview opens and releases realm" });
  await cdp("Page.navigate", { url: url + "?sandbox=1" });
  await wait("window.latest?.ready", 30);
  assert.ok((await ev("latest.drawCalls")) > 0);
  checks.push({
    name: "opaque-origin sandbox iframe with relative models/JPG",
  });
  const metrics = await ev("latest");
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  fs.writeFileSync(
    path.join(evidence, "browser-report.json"),
    JSON.stringify(
      {
        sourceURL: url,
        checks,
        errors,
        failures,
        metrics,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ checks: checks.length, waves, metrics }, null, 2),
  );
} catch (e) {
  fs.writeFileSync(
    path.join(evidence, "browser-partial.json"),
    JSON.stringify({ checks, errors, failures }, null, 2),
  );
  console.error(e);
  console.error(JSON.stringify({ errors, failures }, null, 2));
  process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  server?.kill("SIGTERM");
}
