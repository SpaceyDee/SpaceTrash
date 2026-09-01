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
let previewAction = null;
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
          { key: "used", value: used, color: v.protected ? "#7eb0ff" : "#ff6b7a" },
          { key: "free", value: free, color: "#4d5e73" },
        ]
      : [{ key: "unknown", value: 1, color: "#2a2638" }];
    const pct = v.totalBytes ? Math.round((used / v.totalBytes) * 100) : 0;
    const card = document.createElement("div");
    card.className = `drive${selected.has(v.path) ? " is-on" : ""}${v.protected ? " is-protected" : ""}`;
    card.dataset.path = v.path;
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "drive-pick";
    pick.setAttribute("aria-pressed", selected.has(v.path) ? "true" : "false");
    pick.setAttribute(
      "aria-label",
      `${v.id} ${v.label || kindLabel(v.kind)}${v.totalBytes ? `, ${pct}% full` : ""}${
        v.protected ? ", protected archive" : ""
      }. Click to ${selected.has(v.path) ? "skip" : "include"}.`,
    );
    pick.innerHTML =
      wheelMarkup(slices, { size: 148, label: v.id, sub: v.protected ? "Archive" : v.label || kindLabel(v.kind) }) +
      `<div class="drive-meta"><b>${escapeHtml(v.protected ? "Protected" : kindLabel(v.kind))}${
        v.totalBytes ? ` · ${pct}% full` : ""
      }</b><small>${
        v.protected ? "Mapped, never recommended for delete" : `${fmtBytes(free)} free`
      }</small></div>`;
    const protect = document.createElement("button");
    protect.type = "button";
    protect.className = "protect-btn";
    protect.setAttribute("aria-pressed", v.protected ? "true" : "false");
    protect.textContent = v.protected ? "Unprotect" : "Protect archive";
    protect.title = v.protected
      ? "SpaceTrash will start recommending deletes here again"
      : "Keep mapping this drive, but never recommend deleting anything on it";
    pick.addEventListener("click", () => toggleDrive(v.path));
    pick.addEventListener("pointerover", (ev) => {
      const slice = ev.target.closest?.(".slice");
      setWheelHot(pick, slice?.getAttribute("data-key") || null);
    });
    pick.addEventListener("pointerleave", () => setWheelHot(pick, null));
    protect.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void toggleProtect(v.path, !v.protected);
    });
    card.append(pick, protect);
    box.appendChild(card);
  }
}

function toggleDrive(path) {
  if (selected.has(path)) selected.delete(path);
  else selected.add(path);
  renderVolumes();
  markLiveDrives();
}

async function toggleProtect(path, on) {
  try {
    volumes = await api("/api/protected", { method: "PUT", body: { path, protected: on } });
    renderVolumes();
    markLiveDrives();
    if (scanId) {
      try {
        await refreshResults();
      } catch {
        // last scan may have failed; the pinwheels still update
      }
    }
    $("scanHint").textContent = on
      ? "Protected archive — SpaceTrash will map it and will not recommend deleting anything here."
      : "Drive unprotected. The next classification can recommend deletes here again.";
  } catch (err) {
    $("scanHint").textContent = err.message;
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
    const pick = el.querySelector(".drive-pick");
    pick?.setAttribute("aria-pressed", selected.has(el.dataset.path) ? "true" : "false");
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
    $("wipeBanner").classList.toggle("hidden", !s.needsScanWipe);
    if (s.needsScanWipe) {
      $("issues").innerHTML = `<p class="empty">Choose whether to clear old scan data after this update.</p>`;
      return;
    }
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

async function loadArchive() {
  const state = await api("/api/archive");
  $("archiveRoot").value = state.root || "";
  const list = $("archiveKinds");
  if (!state.kinds?.length) {
    list.innerHTML = `<li>No kind folders labeled yet.</li>`;
    return;
  }
  list.innerHTML = state.kinds
    .map((k) => `<li><b>${escapeHtml(k.name)}</b> — ${escapeHtml(k.path)}</li>`)
    .join("");
}

async function saveArchiveRoot() {
  const root = $("archiveRoot").value.trim();
  if (!root) {
    $("scanHint").textContent = "Type an archive root path first (not inside your user profile).";
    return;
  }
  try {
    await api("/api/archive", { method: "PUT", body: { root } });
    await loadArchive();
    $("scanHint").textContent = "Archive root saved. Leftovers can move here after Confirm.";
    if (scanId) await refreshResults();
  } catch (err) {
    $("scanHint").textContent = err.message;
  }
}

async function resolveWipe(wipe) {
  try {
    await api("/api/scan-data", { method: "POST", body: { wipe } });
    $("wipeBanner").classList.add("hidden");
    scanId = null;
    summaryCache = null;
    renderClassWheel();
    $("issues").innerHTML = wipe
      ? `<p class="empty">Scan data cleared. Scan again to classify with the new rules.</p>`
      : `<p class="empty">Kept the old index. Scan again if findings look stale.</p>`;
    await loadStatus();
  } catch (err) {
    $("scanHint").textContent = err.message;
  }
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
      $("scanHint").textContent = job.error
        ? `Finished with warnings. ${job.error}`
        : "Done. Hover the pinwheel to inspect a slice.";
      await refreshResults();
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      setScanControls(false);
      markLiveDrives();
      $("progressText").textContent = job.error || job.status;
      $("scanHint").textContent =
        job.status === "cancelled"
          ? "Stopped. Scan again whenever you like."
          : "Scan failed. Try again — the last good result stays on the wheel if we have one.";
      $("issues").innerHTML = `<p class="empty">${escapeHtml(job.error || "Scan failed.")}</p>`;
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
    const empty =
      cls
        ? "Nothing in this slice. Try another, or scan a different drive."
        : summaryCache && summaryCache.filesSeen > 100 && summaryCache.bytesSeen === 0
          ? "The scan did not index files. Try Scan again."
          : "No issues in this filter. That can be good.";
    box.innerHTML = `<p class="empty">${empty}</p>`;
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
  previewAction = null;
  $("confirmBtn").classList.add("hidden");
  $("dPreview").classList.add("hidden");
  $("dTitle").textContent = selectedFinding.title;
  $("dMeta").textContent = `${selectedFinding.class} · ${selectedFinding.action} · risk ${selectedFinding.risk} · ${Math.round(selectedFinding.confidence * 100)}% confident · ${fmtBytes(selectedFinding.bytes)}`;
  $("dWhy").textContent = selectedFinding.why;
  $("dPaths").innerHTML = selectedFinding.paths.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  const allowed = selectedFinding.allowedActions || [selectedFinding.action];
  $("previewBtn").disabled = selectedFinding.status === "applied";
  $("previewBtn").textContent =
    selectedFinding.action === "label"
      ? "Preview label"
      : selectedFinding.action === "archive"
        ? "Preview move"
        : "Preview recycle";
  $("recyclePreviewBtn").classList.toggle("hidden", !allowed.includes("recycle") || selectedFinding.action === "recycle");
  $("drawerRootWrap").classList.toggle("hidden", !selectedFinding.needsArchiveRoot);
  $("drawerArchiveRoot").value = $("archiveRoot").value;
  $("confirmBtn").textContent = "Confirm";
  openDrawer(true);
}

async function doPreview(action) {
  if (!selectedFinding) return;
  const chosen = typeof action === "string" ? action : selectedFinding.action;
  try {
    const archiveRoot = $("drawerArchiveRoot").value.trim() || $("archiveRoot").value.trim() || undefined;
    const preview = await api(`/api/findings/${selectedFinding.id}/preview`, {
      method: "POST",
      body: { action: chosen, archiveRoot },
    });
    previewToken = preview.token;
    previewAction = preview.action;
    $("dPreview").classList.remove("hidden");
    const lines = [
      `Action: ${preview.action}`,
      `Expires: ${new Date(preview.expiresAt).toLocaleTimeString()}`,
      preview.destPath ? `Destination: ${preview.destPath}` : "",
      "Paths:",
      ...preview.paths.map((p) => `  ${p}`),
    ].filter(Boolean);
    if (preview.action === "recycle") {
      lines.push("", "Confirm sends these items to the Recycle Bin. They are not hard-deleted.");
    } else if (preview.action === "label") {
      lines.push("", "Confirm labels this folder as an archive. Files already in it stay put.");
    } else if (preview.action === "archive" && selectedFinding.kind) {
      lines.push("", "Confirm moves these files into the archive folder.");
    } else {
      lines.push("", "This archive action is preview-only unless it is a labeled installer or disk-image tidy-up.");
    }
    $("dPreview").textContent = lines.join("\n");
    const canConfirm =
      preview.action === "recycle" ||
      preview.action === "label" ||
      (preview.action === "archive" && selectedFinding.kind);
    $("confirmBtn").classList.toggle("hidden", !canConfirm);
    $("confirmBtn").textContent =
      preview.action === "recycle" ? "Confirm recycle" : preview.action === "label" ? "Confirm label" : "Confirm move";
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
    await loadArchive();
  } catch (err) {
    $("dPreview").textContent = err.message;
  } finally {
    $("confirmBtn").disabled = false;
  }
}

$("scanBtn").addEventListener("click", startScan);
$("stopBtn").addEventListener("click", stopScan);
$("saveArchiveRoot").addEventListener("click", () => void saveArchiveRoot());
$("wipeScanBtn").addEventListener("click", () => void resolveWipe(true));
$("keepScanBtn").addEventListener("click", () => void resolveWipe(false));
$("closeDrawer").addEventListener("click", () => openDrawer(false));
$("backdrop").addEventListener("click", () => openDrawer(false));
$("previewBtn").addEventListener("click", () => void doPreview());
$("recyclePreviewBtn").addEventListener("click", () => void doPreview("recycle"));
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
loadArchive().catch(() => undefined);
loadVolumes().catch((err) => {
  $("volumes").innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
});
