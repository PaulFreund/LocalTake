// Run against the dev server: node scripts/studio-smoke.mjs [studio URL] [transfer].
// Uses an isolated headless Chromium profile and disposable diagnostic storage.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import assert from "node:assert/strict";

const url = process.argv[2] || "http://localhost:43175/";
const binary =
  process.env.LOCALTAKE_CHROMIUM ||
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = await mkdtemp(join(tmpdir(), "localtake-smoke-"));
const browser = spawn(
  binary,
  [
    "--headless=new",
    "--remote-debugging-port=43176",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "about:blank",
  ],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
);
let browserErrors = "";
browser.stderr.on("data", (chunk) => {
  browserErrors = (browserErrors + chunk.toString()).slice(-8000);
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let socket;
let next = 1;
const requests = new Map();
const diagnostics = [];
const cspIssues = [];
const loadedPages = new Set();
let listener;
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = next++;
    const timeout = setTimeout(() => {
      requests.delete(id);
      reject(
        new Error(
          `CDP timeout: ${method} ${String(params.expression || "").slice(0, 160)}`,
        ),
      );
    }, 90_000);
    requests.set(id, { resolve, reject, timeout });
    socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
const evaluate = async (page, expression) => {
  const split = expression.lastIndexOf(";");
  const body =
    split < 0
      ? `return (${expression});`
      : `${expression.slice(0, split)}; return (${expression.slice(split + 1)});`;
  const result = await send(
    "Runtime.evaluate",
    {
      expression: `(async()=>{${body}})()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    page,
  );
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = async (page, expression, label, timeout = 60_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(page, expression)) return;
    await delay(200);
  }
  throw new Error(
    `${label}: ${JSON.stringify(await evaluate(page, "({error:s.error,notice:s.notice,readiness:s.readinessReason,probe:s.probing,blocked:s.startBlocked,group:s.room.state?.take,upload:s.sync.status,transfers:[...s.transfer.transfers.values()].map(t=>({state:t.state,error:t.error,bytes:t.bytes,total:t.total})),recording:s.recording?.status,library:s.library.map(i=>({complete:i.complete,issues:i.issues})),workers:globalThis.workerMessages?.filter(m=>m.status?.kind==='video'||m.error).slice(-35)})"))}`,
  );
};
const bindStudio = async (page) => {
  let lastError;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if (
        await evaluate(
          page,
          "globalThis.s=document.getElementById('root')?.__vue_app__?._instance?.setupState.studio; Boolean(s?.capture)",
        )
      )
        return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Vue studio could not be loaded: ${String(lastError)}`);
};
const createPage = async () => {
  const context = await send("Target.createBrowserContext");
  const target = await send("Target.createTarget", {
    url,
    browserContextId: context.browserContextId,
  });
  const attached = await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const page = attached.sessionId;
  await send("Runtime.enable", {}, page);
  // Reports issues collected since the page started, e.g. blocked eval.
  await send("Audits.enable", {}, page);
  await send("Page.enable", {}, page);
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    page,
  );
  await bindStudio(page);
  // Without a remembered folder the studio opens with the mandatory folder dialog.
  await wait(
    page,
    "/Aufnahmeordner wählen/.test(document.querySelector('[role=dialog]')?.textContent || '')",
    "Storage dialog",
    10_000,
  );
  return page;
};
const storageReady = (page) =>
  wait(
    page,
    "!!s.store && !document.querySelector('[role=dialog]')",
    "Storage dialog closed",
    10_000,
  );
try {
  let metadata;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      metadata = await fetch("http://localhost:43176/json/version").then((r) =>
        r.json(),
      );
      break;
    } catch {
      await delay(200);
    }
  }
  assert(
    metadata?.webSocketDebuggerUrl,
    `Chromium did not start: ${browserErrors}`,
  );
  socket = new WebSocket(metadata.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("close", () => {
    for (const request of requests.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Browser closed"));
    }
    requests.clear();
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id) {
      const request = requests.get(message.id);
      if (request) {
        clearTimeout(request.timeout);
        requests.delete(message.id);
        if (message.error)
          request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    } else if (message.method === "Runtime.exceptionThrown")
      diagnostics.push(message.params.exceptionDetails);
    else if (message.method === "Page.javascriptDialogOpening") {
      diagnostics.push({ dialog: message.params.type });
      console.log(`Browser warning: ${message.params.type}`);
      void send(
        "Page.handleJavaScriptDialog",
        { accept: true },
        message.sessionId,
      ).catch((error) => diagnostics.push({ dialogError: String(error) }));
    } else if (message.method === "Page.loadEventFired")
      loadedPages.add(message.sessionId);
    else if (
      message.method === "Audits.issueAdded" &&
      message.params.issue.code === "ContentSecurityPolicyIssue"
    )
      cspIssues.push(message.params.issue.details);
    listener?.(message);
  });
  console.log(`Browser: ${metadata.Browser}`);
  if (process.argv[3] !== "transfer") {
    // Independent 4K encoder/file check, repeated to exercise initialization races.
    const fourK = await createPage();
    await evaluate(
      fourK,
      `s.setName('4K Test'); s.quality='2160'; await s.diagnosticStorage();
      await s.ensureDefaultSources();
      const defaults=s.capture.sources.map(x=>x.kind).sort().join(',');
      if(defaults!=='audio,video') throw new Error('Default sources: '+defaults);
      const mic=s.capture.sources.find(x=>x.kind==='audio');
      const other=s.devices.find(d=>d.kind==='audioinput'&&d.deviceId&&!['default','communications'].includes(d.deviceId)&&d.deviceId!==mic.settings.deviceId);
      if(other){ await s.switchSource(mic.id, other.deviceId); const now=s.capture.sources.filter(x=>x.kind==='audio'); if(now.length!==1||now[0].settings.deviceId!==other.deviceId) throw new Error('Device switch failed'); }
      globalThis.switched=other?.label||false;
      for(const x of [...s.capture.sources]) s.capture.remove(x.id);
      const canvas=document.createElement('canvas'); canvas.width=3840; canvas.height=2160;
      const ctx=canvas.getContext('2d'); let frame=0;
      const draw=()=>{ctx.fillStyle='#173948';ctx.fillRect(0,0,3840,2160);ctx.fillStyle='#ffff00';ctx.fillRect((frame++*45)%3700,700,140,600);};
      draw(); const timer=setInterval(draw,1000/30); const stream=canvas.captureStream(30);
      await s.capture.register({id:crypto.randomUUID(),label:'4K Canvas',kind:'video',track:stream.getVideoTracks()[0],stream,settings:stream.getVideoTracks()[0].getSettings(),synthetic:true,cleanup:()=>clearInterval(timer)});
      s.invalidate(); true`,
    );
    await storageReady(fourK);
    console.log(
      JSON.stringify({
        stage: "default-sources",
        switchedMicrophone: await evaluate(fourK, "globalThis.switched"),
      }),
    );
    await wait(
      fourK,
      "s.probePassed && !s.probing",
      "Automatic 4K check",
      30_000,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await evaluate(fourK, "await s.record(); true");
      await delay(5500);
      await evaluate(fourK, "await s.record(); true");
      const result = await evaluate(
        fourK,
        "({status:s.lastRecording.status,inventory:s.library[0]})",
      );
      assert.equal(result.status.state, "saved", JSON.stringify(result.status));
      assert.equal(
        result.inventory.complete,
        true,
        JSON.stringify(result.inventory.issues),
      );
      assert.equal(result.inventory.tracks[0].width, 3840);
      console.log(
        JSON.stringify({
          stage: "4k",
          attempt,
          status: result.status,
          complete: result.inventory.complete,
        }),
      );
    }
    await send("Page.close", {}, fourK);
  }
  const host = await createPage(),
    guest = await createPage();
  console.log("Browser pages ready");
  for (const [page, name] of [
    [host, "Host"],
    [guest, "Gast"],
  ]) {
    await send("Page.bringToFront", {}, page);
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }, page);
    await evaluate(
      page,
      "globalThis.workerMessages=[]; globalThis.NativeWorker=Worker; globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);this.addEventListener('message',e=>{workerMessages.push(e.data);if(workerMessages.length>200)workerMessages.shift()});this.addEventListener('error',e=>workerMessages.push({error:e.message}))}};true",
    );
    await evaluate(
      page,
      `s.setName(${JSON.stringify(name)}); await s.diagnosticStorage(); await s.ensureDefaultSources(); await s.capture.synthetic(); for(const kind of ['audio','video']) { const keep=s.capture.sources.find(x=>x.kind===kind&&x.synthetic); for(const source of s.capture.sources.filter(x=>x.kind===kind&&x!==keep)) s.capture.remove(source.id); } s.invalidate(); true`,
    );
    await storageReady(page);
    await wait(
      page,
      "s.probePassed && s.armed && !s.probing",
      "Automatic source check",
    );
    assert.equal(
      await evaluate(page, "s.library.length"),
      0,
      "Background check polluted the archive",
    );
    console.log(`${name}: automatic check ready`);
  }
  await evaluate(host, "s.roomName='Smoke-Test'; await s.createRoom(); true");
  console.log("Host: room created");
  await wait(host, "s.room.connected", "Host connection");
  const invite = await evaluate(host, "s.room.credentials.inviteToken");
  const roomId = await evaluate(host, "s.room.credentials.roomId");
  assert(
    (await evaluate(host, "location.hash")).includes(roomId),
    "Room URL was not retained",
  );
  await evaluate(
    guest,
    `s.invite=${JSON.stringify(invite)}; await s.joinRoom(); true`,
  );
  console.log("Gast: room joined");
  await wait(
    host,
    "s.room.state?.peers.length === 2 && s.room.state.peers.every(p=>p.ready)",
    "Both peers ready before quality change",
  );
  // The host's profile applies to the whole room; the guest follows it.
  await evaluate(host, "await s.setQuality('720'); true");
  await wait(guest, "s.quality === '720'", "Guest adopts host quality");
  assert.equal(
    await evaluate(
      guest,
      "!!document.querySelector('[aria-label=\"Aufnahmequalität\"]')",
    ),
    false,
    "Guest must not get its own quality selector",
  );
  console.log("Quality set by host and adopted by guest");
  await wait(
    host,
    "s.room.state?.peers.length === 2 && s.room.state.peers.every(p=>p.ready)",
    "Both peers ready",
  );
  await wait(
    guest,
    "[...s.mesh.remotes.values()].some(r=>r.files?.readyState==='open')",
    "P2P channels",
  );
  console.log("Peers ready and channels open");
  // Slow this test's sender so reload reliably interrupts a live file transfer.
  await evaluate(guest, "s.transfer.bytesPerSecond=()=>64000; true");
  await evaluate(host, "await s.record(); true");
  console.log("Group recording requested");
  await wait(
    host,
    "!!s.recording && s.recording.status.sources.length===2",
    "Host recording",
  );
  await wait(
    guest,
    "!!s.recording && s.recording.status.sources.length===2",
    "Guest recording",
  );
  await delay(5500);
  console.log("Stopping group recording");
  await evaluate(host, "await s.record(); true");
  console.log("Host locally saved");
  await wait(
    guest,
    "!s.recording && s.sync.status.pending>0",
    "Automatic upload queue",
  );
  await wait(
    guest,
    "[...s.transfer.transfers.values()].some(t=>t.state==='transferring')",
    "Automatic transfer start",
  );
  assert.equal(
    await evaluate(guest, "s.syncDialog"),
    true,
    "Missing upload close warning",
  );
  await wait(
    guest,
    "/nicht\\s+schließen/.test(document.querySelector('[role=dialog]')?.textContent || '')",
    "Visible upload close warning",
  );
  loadedPages.delete(guest);
  await send("Page.reload", {}, guest);
  console.log("Gast: reloading during upload");
  for (let attempt = 0; attempt < 150 && !loadedPages.has(guest); attempt++)
    await delay(200);
  assert(
    loadedPages.has(guest),
    `Reload did not finish: ${JSON.stringify(diagnostics)}`,
  );
  await bindStudio(guest);
  await wait(
    guest,
    `s.room.connected && s.room.credentials.roomId===${JSON.stringify(roomId)} && !!s.store`,
    "Room and storage restore",
  );
  await wait(
    guest,
    "s.sync.status.state==='done' && s.sync.status.pending===0",
    "Automatic resumed upload",
    60_000,
  );
  await wait(
    host,
    "s.library.length===2 && s.library.every(i=>i.complete) && !s.uploadPending",
    "Receiver archive and session export",
    60_000,
  );
  const sessionFolders = await evaluate(
    host,
    "await Array.fromAsync((await s.store.root.getDirectoryHandle('Smoke-Test')).values()).then(entries=>entries.filter(e=>e.name.startsWith('Aufnahme-')).map(e=>e.name))",
  );
  assert.equal(sessionFolders.length, 1, "Missing collected session directory");
  // One take is one session: the host sees every participant fully received,
  // the guest only its own completed upload.
  const hostSession = await evaluate(
    host,
    "({role:s.currentSession?.role,settled:s.currentSession?.settled,participants:s.currentSession?.participants.map(p=>[p.name,p.state]),manifests:s.manifests.map(m=>m.participants.length),sessions:s.sessions.length})",
  );
  assert.deepEqual(
    hostSession,
    {
      role: "master",
      settled: true,
      participants: [
        ["Host", "done"],
        ["Gast", "done"],
      ],
      manifests: [2],
      sessions: 1,
    },
    JSON.stringify(hostSession),
  );
  const guestSession = await evaluate(
    guest,
    "({role:s.currentSession?.role,participants:s.currentSession?.participants.map(p=>[p.name,p.state])})",
  );
  assert.deepEqual(
    guestSession,
    { role: "slave", participants: [["Gast", "done"]] },
    JSON.stringify(guestSession),
  );
  console.log(
    JSON.stringify({
      stage: "two-browser-resume",
      sessions: sessionFolders,
      host: await evaluate(
        host,
        "s.library.map(i=>({complete:i.complete,tracks:i.tracks.length,issues:i.issues,warnings:i.warnings}))",
      ),
      guest: await evaluate(guest, "s.sync.status"),
    }),
  );
  await mkdir("work", { recursive: true });
  await evaluate(host, "s.syncDialog=false;s.changed();true");
  const tile = await evaluate(
    host,
    "Object.fromEntries(['width','height'].map(key=>[key,document.querySelector('article').getBoundingClientRect()[key]]))",
  );
  assert(
    Math.abs(tile.width / tile.height - 16 / 9) < 0.02,
    `Preview is not landscape: ${JSON.stringify(tile)}`,
  );
  const screenshot = await send(
    "Page.captureScreenshot",
    { format: "png" },
    host,
  );
  await writeFile(
    "work/studio-smoke.png",
    Buffer.from(screenshot.data, "base64"),
  );
  await evaluate(
    host,
    "[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent.includes('Aufnahmen')).click(); true",
  );
  await wait(
    host,
    "/Aktuelle Sitzung/.test(document.body.textContent) && !!document.querySelector('[aria-label=\"Teilnehmer und Übertragung\"]')",
    "Session view",
  );
  await writeFile(
    "work/studio-smoke-session.png",
    Buffer.from(
      (await send("Page.captureScreenshot", { format: "png" }, host)).data,
      "base64",
    ),
  );
  assert.deepEqual(cspIssues, [], "Content Security Policy violations");
  console.log(
    JSON.stringify({
      browser: metadata.Browser,
      diagnostics,
      screenshot: "work/studio-smoke.png",
    }),
  );
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await send("Browser.close").catch(() => {});
    socket.close();
  }
  browser.kill();
}
