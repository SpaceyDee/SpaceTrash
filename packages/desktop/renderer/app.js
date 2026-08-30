const $ = (id) => document.getElementById(id);

let volumes = [];
let scanId = null;
let filterClass = "";
let selectedFinding = null;
let previewToken = null;
let pollTimer = null;

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

async function loadStatus() {
  try {
    const s = await api("/api/status");
    $("statusLine").textContent = `${s.name} ${s.version} · ${s.platform} · API up`;
  } catch {
    $("statusLine").textContent = "API offline";
  }
}

async function loadVolumes() {
  volumes = await api("/api/volumes");
  const box = $("volumes");
  box.innerHTML = "";
  for (const v of volumes) {
    const used = v.totalBytes ? v.totalBytes - v.freeBytes : 0;
    const label = document.createElement("label");
    label.className = "vol";
    const checked = v.kind === "fixed" ? "checked" : "";
    label.innerHTML = `
      <input type="checkbox" value="${v.path}" ${checked} />
      <span><b>${v.id} ${v.label || ""}</b><small>${v.kind} · ${fmtBytes(used)} used of ${fmtBytes(v.totalBytes)}</small></span>
    `;
    box.appendChild(label);
  }
}

function selectedRoots() {
  const folder = $("folderOverride").value.trim();
  if (folder) return [folder];
  return [...document.querySelectorAll("#volumes input:checked")].map((el) => el.value);
}

async function startScan() {
  const roots = selectedRoots();
  if (!roots.length) {
    $("scanHint").textContent = "Select at least one volume.";
    return;
  }
  $("scanBtn").disabled = true;
  $("progressWrap").classList.remove("hidden");
  $("issues").textContent = "Scanning…";
  try {
    const job = await api("/api/scans", { method: "POST", body: { roots } });
    scanId = job.id;
    pollScan();
  } catch (err) {
    $("scanHint").textContent = err.message;
    $("scanBtn").disabled = false;
  }
}

async function pollScan() {
  clearTimeout(pollTimer);
  if (!scanId) return;
  try {
    const job = await api(`/api/scans/${scanId}`);
    const pct = Math.round((job.progress || 0) * 100);
    $("progressBar").style.width = `${pct}%`;
    $("progressText").textContent = `${job.status} · ${job.filesSeen.toLocaleString()} files · ${fmtBytes(job.bytesSeen)} · ${job.currentPath || ""}`;
    if (job.status === "complete") {
      $("scanBtn").disabled = false;
      await refreshResults();
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      $("scanBtn").disabled = false;
      $("progressText").textContent = job.error || job.status;
      return;
    }
  } catch (err) {
    $("progressText").textContent = err.message;
  }
  pollTimer = setTimeout(pollScan, 600);
}

async function refreshResults() {
  if (!scanId) return;
  const summary = await api(`/api/scans/${scanId}/summary`);
  $("c-removable").textContent = fmtBytes(summary.byClass.removable.bytes);
  $("c-bloat").textContent = fmtBytes(summary.byClass.bloat.bytes);
  $("c-archiveable").textContent = fmtBytes(summary.byClass.archiveable.bytes);
  $("c-keep").textContent = fmtBytes(summary.keepBytes);
  const q = filterClass ? `?class=${filterClass}` : "";
  const findings = await api(`/api/scans/${scanId}/findings${q}`);
  const box = $("issues");
  box.innerHTML = "";
  if (!findings.length) {
    box.textContent = "No issues in this filter. That can be good.";
    return;
  }
  for (const f of findings) {
    const row = document.createElement("div");
    row.className = "issue";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `
      <div><b>${f.title}</b><div><em>${f.fileCount} items · ${f.why}</em></div></div>
      <span class="badge ${f.class}">${f.class}</span>
      <b>${fmtBytes(f.bytes)}</b>
    `;
    row.addEventListener("click", () => openFinding(f.id));
    box.appendChild(row);
  }
}

async function openFinding(id) {
  selectedFinding = await api(`/api/findings/${id}`);
  previewToken = null;
  $("confirmBtn").classList.add("hidden");
  $("dPreview").classList.add("hidden");
  $("dTitle").textContent = selectedFinding.title;
  $("dMeta").textContent = `${selectedFinding.class} · ${selectedFinding.action} · risk ${selectedFinding.risk} · ${Math.round(selectedFinding.confidence * 100)}% confident · ${fmtBytes(selectedFinding.bytes)}`;
  $("dWhy").textContent = selectedFinding.why;
  $("dPaths").innerHTML = selectedFinding.paths.map((p) => `<li>${p}</li>`).join("");
  $("previewBtn").disabled = selectedFinding.status === "applied";
  $("confirmBtn").textContent = selectedFinding.action === "recycle" ? "Confirm recycle" : "Confirm (preview-only)";
  $("drawer").classList.remove("hidden");
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
$("closeDrawer").addEventListener("click", () => $("drawer").classList.add("hidden"));
$("previewBtn").addEventListener("click", doPreview);
$("confirmBtn").addEventListener("click", doConfirm);
$("filters").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-class]");
  if (!btn) return;
  filterClass = btn.getAttribute("data-class") || "";
  for (const el of $("filters").querySelectorAll(".chip")) el.classList.toggle("on", el === btn);
  void refreshResults();
});

loadStatus();
loadVolumes().catch((err) => {
  $("volumes").textContent = err.message;
});
