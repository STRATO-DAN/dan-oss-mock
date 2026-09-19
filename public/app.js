// [DAN] MOCK — real client logic, plain fetch + DOM, no framework.

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadStatus() {
  $("status").innerHTML = `The real mock endpoint is this same origin — e.g. ` +
    `<code>${escapeHtml(location.origin)}/api/users</code>. Routes are saved to ` +
    `<code>.dan-oss-mock.json</code> next to wherever you ran <code>dan-oss-mock</code>.`;
}

async function loadRoutes() {
  const res = await fetch("/_mock/api/routes");
  const data = await res.json();
  const list = $("routeList");
  if (!data.ok || data.routes.length === 0) {
    list.innerHTML = `<li class="empty-note">No real routes yet — add one above.</li>`;
    return;
  }
  list.innerHTML = data.routes.map((r) => {
    const bodyPreview = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const short = bodyPreview.length > 40 ? bodyPreview.slice(0, 40) + "…" : bodyPreview;
    // Colour-code the verb: a real HTTP method gets its own class; the "*" wildcard shows as ANY.
    const methodKey = /^[A-Z]+$/.test(r.method) ? r.method : "ANY";
    const methodLabel = r.method === "*" ? "ANY" : r.method;
    return `
      <li class="route-row${r.enabled ? "" : " disabled"}" data-id="${r.id}">
        <span class="route-method m-${methodKey}">${escapeHtml(methodLabel)}</span>
        <span class="route-path">
          ${escapeHtml(r.path)}
          <div class="hint route-meta">→ ${r.status}${r.delayMs ? ` · ${r.delayMs}ms delay` : ""}${short ? ` · ${escapeHtml(short)}` : ""}</div>
        </span>
        <span class="route-actions">
          <button class="icon-btn" data-action="toggle">${r.enabled ? "disable" : "enable"}</button>
          <button class="icon-btn" data-action="delete">delete</button>
        </span>
      </li>`;
  }).join("");
}

async function addRoute(e) {
  e.preventDefault();
  const status = $("formStatus");
  const path = $("fPath").value.trim();
  if (!path.startsWith("/")) {
    status.textContent = "Path must start with /";
    return;
  }
  let body = $("fBody").value;
  // A real JSON body is stored parsed (so it serves as real JSON, not a JSON-encoded string);
  // anything that doesn't parse is kept as plain text — an honest fallback, not a forced error
  // for a tool whose whole point is mocking ANY response, not just JSON ones.
  try {
    body = body.trim() ? JSON.parse(body) : {};
  } catch {
    // keep as raw string
  }
  const payload = {
    method: $("fMethod").value,
    path,
    status: Number($("fStatus").value) || 200,
    body,
    delayMs: Number($("fDelay").value) || 0,
  };
  status.innerHTML = `<span class="dan-seal"></span>Adding the route…`;
  const res = await fetch("/_mock/api/routes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    status.textContent = data.reason;
    return;
  }
  status.textContent = "Added.";
  $("routeForm").reset();
  $("fStatus").value = 200;
  $("fDelay").value = 0;
  await loadRoutes();
}

async function onListClick(e) {
  const btn = e.target.closest(".icon-btn");
  if (!btn) return;
  const row = e.target.closest(".route-row");
  const id = row.dataset.id;
  if (btn.dataset.action === "delete") {
    // A route is real config someone entered — confirm before removing it.
    const path = row.querySelector(".route-path")?.textContent.trim().split("\n")[0] || "this route";
    if (!confirm(`Delete ${path}? This can't be undone.`)) return;
    await fetch(`/_mock/api/routes/${id}`, { method: "DELETE" });
  } else if (btn.dataset.action === "toggle") {
    const enabled = row.classList.contains("disabled"); // currently disabled -> enable
    await fetch(`/_mock/api/routes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  }
  await loadRoutes();
}

$("routeForm").addEventListener("submit", addRoute);
$("routeList").addEventListener("click", onListClick);

(async () => {
  await loadStatus();
  await loadRoutes();
})();
