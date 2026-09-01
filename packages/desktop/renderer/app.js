const $ = (id) => document.getElementById(id);

const CLASS_META = [
  { key: "removable", label: "Removable", color: "#ff8d6a", hint: "caches, installers, scratch" },
  { key: "bloat", label: "Bloat", color: "#f0b429", hint: "old copies, stale trees" },
  { key: "archiveable", label: "Archive", color: "#7eb0ff", hint: "large and unused" },
  { key: "keep", label: "Keep", color: "#c4bdd4", hint: "everything else scanned" },
];

let volumes = [];
let selected = new Set();
let scanId = null;
let filterClass = "";
let hoverClass = "";
let selectedFinding = null;
let previewToken = null;
let pollTimer = null;
let summaryCache = null;
let scanRunning = false;

function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function kindLabel(kind) {
  return { fixed: "Disk", removable: "USB", network: "Network", cdrom: "Disc" }[kind] || "Drive";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slicePath(inner, outer, a0, a1) {
  const sweep = a1 - a0;
  if (sweep <= 0.0008) return "";
  const large = sweep > Math.PI ? 1 : 0;
  const p = (r, a) => `${(Math.cos(a) * r).toFixed(3)} ${(Math.sin(a) * r).toFixed(3)}`;
  return `M${p(outer, a0)} A${outer} ${outer} 0 ${large} 1 ${p(outer, a1)} L${p(inner, a1)} A${inner} ${inner} 0 ${large} 0 ${p(inner, a0)} Z`;
}

function wheelMarkup(slices, { size = 148, hole = 0.56, label = "", sub = "" } = {}) {
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const visible = slices.filter((s) => s.value > 0);
  const gap = visible.length > 1 ? 0.05 : 0;
  const outer = size * 0.42;
  const inner = outer * hole;
  let angle = -Math.PI / 2;
  const parts = [];
  if (!total) {
    parts.push(`<circle class="empty-ring" r="${outer - 6}" fill="none" stroke="#5c5574" stroke-width="14" stroke-linecap="round" />`);
  } else {
    for (const slice of slices) {
      const span = (Math.max(0, slice.value) / total) * Math.PI * 2;
      const a0 = angle + gap / 2;
      const a1 = angle + span - gap / 2;
      angle += span;
      if (slice.value <= 0 || a1 <= a0) continue;
      parts.push(
        `<path class="slice" data-key="${slice.key}" d="${slicePath(inner, outer, a0, a1)}" fill="${slice.color}"></path>`,
      );
    }
  }
  const trackR = outer + 9;
  return `
    <div class="wheel" style="--wheel:${size}px">
      <svg viewBox="${-size / 2} ${-size / 2} ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
        <g class="tumble">
          ${parts.join("")}
          <circle class="select-ring" r="${outer + 5}"></circle>
          <circle class="track-ring" r="${trackR}"></circle>
        </g>
      </svg>
      <div class="hub"><strong>${escapeHtml(label)}</strong><em>${escapeHtml(sub)}</em></div>
    </div>
  `;
}

function setWheelHot(root, key) {
  if (!root) return;
  for (const el of root.querySelectorAll(".slice, .legend li")) {
    el.classList.toggle("is-hot", Boolean(key) && el.getAttribute("data-key") === key);
  }
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function activeClass() {
  return hoverClass || filterClass;
}

function setScanControls(running) {
  scanRunning = running;
  $("scanBtn").disabled = running;
  $("stopBtn").classList.toggle("hidden", !running);
  $("stopBtn").disabled = !running;
}

function selectedRoots() {
  const folder = $("folderOverride").value.trim();
  if (folder) return [folder];
  return [...selected];
}

function renderVolumes() {
  const box = $("volumes");
  box.innerHTML = "";
  if (!volumes.length) {
    box.innerHTML = `<p class="empty">No drives showed up. Try a folder path below.</p>`;
    return;
  }
  for (const v of volumes) {
    const used = v.totalBytes ? Math.max(0, v.totalBytes - v.freeBytes) : 0;
    const free = v.freeBytes || 0;
    const slices = v.totalBytes
      ? [
          { key: "used", value: used, color: "#ff6b7a" },
          { key: "free", value: free, color: "#4d5e73" },
        ]
      : [{ key: "unknown", value: 1, color: "#2a2638" }];
    const pct = v.totalBytes ? Math.round((used / v.totalBytes) * 100) : 0;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `drive${selected.has(v.path) ? " is-on" : ""}`;
    btn.dataset.path = v.path;
    btn.setAttribute("aria-pressed", selected.has(v.path) ? "true" : "false");
    btn.setAttribute(
      "aria-label",
      `${v.id} ${v.label || kindLabel(v.kind)}${v.totalBytes ? `, ${pct}% full` : ""}. Click to ${selected.has(v.path) ? "skip" : "include"}.`,
    );
    btn.innerHTML =
      wheelMarkup(slices, { size: 148, label: v.id, sub: v.label || kindLabel(v.kind) }) +
      `<div class="drive-meta"><b>${escapeHtml(kindLabel(v.kind))}${
        v.totalBytes ? ` · ${pct}% full` : ""
      }</b><small>${fmtBytes(free)} free</small></div>`;
    btn.addEventListener("click", () => toggleDrive(v.path));
    btn.addEventListener("pointerover", (ev) => {
      const slice = ev.target.closest?.(".slice");
      setWheelHot(btn, slice?.getAttribute("data-key") || null);
    });
    btn.addEventListener("pointerleave", () => setWheelHot(btn, null));
    box.appendChild(btn);
  }
}

function toggleDrive(path) {
  if (selected.has(path)) selected.delete(path);
  else selected.add(path);
  renderVolumes();
  markLiveDrives();
}

function markLiveDrives(currentPath = "") {
  const running = scanRunning;
  const live = new Set();
  if (running) {
    for (const root of selected) {
      const letter = root.slice(0, 2).toLowerCase();
      if (!currentPath || currentPath.toLowerCase().includes(letter)) live.add(root);
    }
    if (!live.size) for (const root of selected) live.add(root);
  }
  for (const el of document.querySelectorAll(".drive")) {
    el.classList.toggle("is-on", selected.has(el.dataset.path));
    el.classList.toggle("is-live", live.has(el.dataset.path));
    el.setAttribute("aria-pressed", selected.has(el.dataset.path) ? "true" : "false");
  }
}

function classSlices() {
  const by = summaryCache?.byClass ?? {};
  return CLASS_META.map((m) => ({
    ...m,
    value: m.key === "keep" ? summaryCache?.keepBytes || 0 : by[m.key]?.bytes || 0,
  }));
}

function renderClassWheel() {
  const host = $("classWheel");
  const slices = classSlices();
  const found = slices.filter((s) => s.key !== "keep").reduce((n, s) => n + s.value, 0);
  const total = slices.reduce((n, s) => n + s.value, 0);
  host.innerHTML = wheelMarkup(slices, {
    size: 300,
    hole: 0.58,
    label: total ? (found ? fmtBytes(found) : "Clean") : "—",
    sub: total ? (found ? "junk spotted" : "nothing flagged") : "Scan to map it",
  });
  const legend = $("classLegend");
  legend.innerHTML = slices
    .map(
      (s) => `
      <li data-key="${s.key}">
        <b><i class="swatch" style="background:${s.color}"></i>${s.label}</b>
        <span>${fmtBytes(s.value)}</span>
      </li>`,
    )
    .join("");
  setWheelHot(document.querySelector(".atlas-wheel"), activeClass());
}

function bindClassHover() {
  const stage = document.querySelector(".atlas-wheel");
  stage.addEventListener("pointerover", (ev) => {
    const hit = ev.target.closest?.("[data-key]");
    if (!hit || !summaryCache) return;
    hoverClass = hit.getAttribute("data-key") === "keep" ? "" : hit.getAttribute("data-key") || "";
    setWheelHot(stage, hit.getAttribute("data-key"));
    void refreshIssues();
  });
  stage.addEventListener("pointerleave", () => {
    hoverClass = "";
    setWheelHot(stage, filterClass || null);
    void refreshIssues();
  });
  stage.addEventListener("click", (ev) => {
    const hit = ev.target.closest?.("[data-key]");
    if (!hit) return;
    const key = hit.getAttribute("data-key") || "";
    filterClass = key === "keep" ? "" : key;
    for (const el of $("filters").querySelectorAll(".chip")) {
      el.classList.toggle("on", (el.getAttribute("data-class") || "") === filterClass);
    }
    void refreshIssues();
  });
}

async function loadStatus() {
  try {
    const s = await api("/api/status");
    $("statusLine").textContent = `${s.name} ${s.version} · ready`;
    if (s.activeScanId) {
      scanId = s.activeScanId;
      $("progressWrap").classList.remove("hidden");
      setScanControls(true);
      pollScan();
      return;
    }
    if (s.lastScanId && !scanId) {
      scanId = s.lastScanId;
      try {
        await refreshResults();
      } catch {
        scanId = null;
      }
    }
  } catch {
    $("statusLine").textContent = "Engine offline";
  }
}

async function loadVolumes() {
  volumes = await api("/api/volumes");
  selected = new Set(volumes.filter((v) => v.kind === "fixed").map((v) => v.path));
  renderVolumes();
}

async function startScan() {
  const roots = selectedRoots();
  if (!roots.length) {
    $("scanHint").textContent = "Pick at least one drive, or type a folder path.";
    return;
  }
  setScanControls(true);
  $("progressWrap").classList.remove("hidden");
  $("issues").innerHTML = `<p class="empty">Sweeping the selected drives…</p>`;
  $("scanHint").textContent = "Walking every selected drive at the same time.";
  try {
    const job = await api("/api/scans", { method: "POST", body: { roots } });
    scanId = job.id;
    markLiveDrives();
    pollScan();
  } catch (err) {
    $("scanHint").textContent = err.message;
    setScanControls(false);
  }
}

async function stopScan() {
  if (!scanId) return;
  $("stopBtn").disabled = true;
  try {
    await api(`/api/scans/${scanId}/cancel`, { method: "POST", body: {} });
    $("scanHint").textContent = "Stopping…";
  } catch (err) {
    $("scanHint").textContent = err.message;
    $("stopBtn").disabled = false;
  }
}

function setProgress(pct) {
  const width = Math.max(0, Math.min(100, pct));
  $("progressBar").style.width = `${width}%`;
  $("trackerBead").style.left = `${width}%`;
}

async function pollScan() {
  clearTimeout(pollTimer);
  if (!scanId) return;
  try {
    const job = await api(`/api/scans/${scanId}`);
    const pct = Math.round((job.progress || 0) * 100);
    setProgress(pct);
    const skip = job.filesSkipped > 0 ? ` · ${Number(job.filesSkipped).toLocaleString()} known` : "";
    const walked = job.filesWalked > 0 ? ` · ${Number(job.filesWalked).toLocaleString()} new` : "";
    $("progressText").textContent =
      `${job.status} · ${Number(job.filesSeen || 0).toLocaleString()} files${walked}${skip} · ${fmtBytes(job.bytesSeen)} · ${job.currentPath || ""}`;
    markLiveDrives(job.currentPath || "");
    if (job.status === "complete") {
      setScanControls(false);
      markLiveDrives();
      $("scanHint").textContent = "Done. Hover the pinwheel to inspect a slice.";
      await refreshResults();
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      setScanControls(false);
      markLiveDrives();
      $("progressText").textContent = job.error || job.status;
      $("scanHint").textContent =
        job.status === "cancelled" ? "Stopped. Scan again whenever you like." : $("scanHint").textContent;
      return;
    }
    setScanControls(true);
  } catch (err) {
    $("progressText").textContent = err.message;
  }
  pollTimer = setTimeout(pollScan, 600);
}

async function refreshResults() {
  if (!scanId) return;
  summaryCache = await api(`/api/scans/${scanId}/summary`);
  renderClassWheel();
  await refreshIssues();
}

async function refreshIssues() {
  const box = $("issues");
  if (!scanId) {
    box.innerHTML = `<p class="empty">Scan a drive and the junk shows up here.</p>`;
    return;
  }
  const cls = activeClass();
  const q = cls ? `?class=${cls}` : "";
  const findings = await api(`/api/scans/${scanId}/findings${q}`);
  box.innerHTML = "";
  if (!findings.length) {
    box.innerHTML = `<p class="empty">${
      cls ? "Nothing in this slice. Try another, or scan a different drive." : "No issues in this filter. That can be good."
    }</p>`;
    return;
  }
  for (const f of findings) {
    const row = document.createElement("div");
    row.className = "issue";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `
      <div><b>${escapeHtml(f.title)}</b><div class="why"><em>${f.fileCount} items · ${escapeHtml(f.why)}</em></div></div>
      <span class="badge ${f.class}">${f.class}</span>
      <b>${fmtBytes(f.bytes)}</b>
    `;
    row.addEventListener("click", () => openFinding(f.id));
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        void openFinding(f.id);
      }
    });
    box.appendChild(row);
  }
}

function openDrawer(open) {
  $("drawer").classList.toggle("open", open);
  $("drawer").setAttribute("aria-hidden", open ? "false" : "true");
  $("backdrop").hidden = !open;
  $("backdrop").classList.toggle("open", open);
  if (open) $("closeDrawer").focus();
}

async function openFinding(id) {
  selectedFinding = await api(`/api/findings/${id}`);
  previewToken = null;
  $("confirmBtn").classList.add("hidden");
  $("dPreview").classList.add("hidden");
  $("dTitle").textContent = selectedFinding.title;
  $("dMeta").textContent = `${selectedFinding.class} · ${selectedFinding.action} · risk ${selectedFinding.risk} · ${Math.round(selectedFinding.confidence * 100)}% confident · ${fmtBytes(selectedFinding.bytes)}`;
  $("dWhy").textContent = selectedFinding.why;
  $("dPaths").innerHTML = selectedFinding.paths.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  $("previewBtn").disabled = selectedFinding.status === "applied";
  $("confirmBtn").textContent = selectedFinding.action === "recycle" ? "Confirm recycle" : "Confirm (preview-only)";
  openDrawer(true);
}

async function doPreview() {
  if (!selectedFinding) return;
  try {
    const preview = await api(`/api/findings/${selectedFinding.id}/preview`, { method: "POST", body: {} });
    previewToken = preview.token;
    $("dPreview").classList.remove("hidden");
    $("dPreview").textContent =
      `Action: ${preview.action}\nExpires: ${new Date(preview.expiresAt).toLocaleTimeString()}\nPaths:\n` +
      preview.paths.map((p) => `  ${p}`).join("\n") +
      (preview.action === "archive"
        ? "\n\nArchive apply is preview-only in v1. Nothing will be moved."
        : "\n\nConfirm sends these items to the Recycle Bin. They are not hard-deleted.");
    $("confirmBtn").classList.toggle("hidden", preview.action !== "recycle");
  } catch (err) {
    $("dPreview").classList.remove("hidden");
    $("dPreview").textContent = err.message;
  }
}

async function doConfirm() {
  if (!previewToken) return;
  $("confirmBtn").disabled = true;
  try {
    const result = await api("/api/actions/apply", { method: "POST", body: { token: previewToken, confirm: true } });
    $("dPreview").textContent = JSON.stringify(result, null, 2);
    $("confirmBtn").classList.add("hidden");
    await refreshResults();
  } catch (err) {
    $("dPreview").textContent = err.message;
  } finally {
    $("confirmBtn").disabled = false;
  }
}

$("scanBtn").addEventListener("click", startScan);
$("stopBtn").addEventListener("click", stopScan);
$("closeDrawer").addEventListener("click", () => openDrawer(false));
$("backdrop").addEventListener("click", () => openDrawer(false));
$("previewBtn").addEventListener("click", doPreview);
$("confirmBtn").addEventListener("click", doConfirm);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") openDrawer(false);
});
$("filters").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-class]");
  if (!btn) return;
  filterClass = btn.getAttribute("data-class") || "";
  hoverClass = "";
  for (const el of $("filters").querySelectorAll(".chip")) el.classList.toggle("on", el === btn);
  setWheelHot(document.querySelector(".atlas-wheel"), filterClass || null);
  void refreshIssues();
});

bindClassHover();
renderClassWheel();
loadStatus();
loadVolumes().catch((err) => {
  $("volumes").innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
});
