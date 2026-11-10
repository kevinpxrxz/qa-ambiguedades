const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const estado = {
  config: null,
  proyectos: [],
  sprints: [],
  areas: [],
  hus: [],
  resultados: [],
  sprintNombre: "",
  analizando: false,
};

const CLAVE_CONFIG = "qa_amb_config";
const NOMBRES_IA = { gemini: "Gemini", anthropic: "Claude", openai: "Compatible con OpenAI" };

// ---------------------------------------------------------------- Detección de IA por API key
// La persona solo pega la clave; el proveedor sale de su prefijo.
const REGLAS_IA = [
  { prueba: /^AIza/, proveedor: "gemini", nombre: "Gemini (Google)" },
  { prueba: /^AQ\./, proveedor: "gemini", nombre: "Gemini (Google)" },
  { prueba: /^sk-ant-/, proveedor: "anthropic", nombre: "Claude (Anthropic)" },
  { prueba: /^sk-or-v1-/, proveedor: "openai", nombre: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { prueba: /^gsk_/, proveedor: "openai", nombre: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { prueba: /^xai-/, proveedor: "openai", nombre: "xAI", baseUrl: "https://api.x.ai/v1" },
  { prueba: /^sk-[a-z0-9]{32}$/i, proveedor: "openai", nombre: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { prueba: /^sk-(?:proj|svcacct|admin)-/, proveedor: "openai", nombre: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { prueba: /^sk-/, proveedor: "openai", nombre: "Compatible con OpenAI", generico: true },
];
const NOMBRES_BASE_IA = [
  [/opencode\.ai/i, "OpenCode"],
  [/deepseek\.com/i, "DeepSeek"],
  [/openrouter\.ai/i, "OpenRouter"],
  [/groq\.com/i, "Groq"],
  [/mistral\.ai/i, "Mistral"],
  [/api\.x\.ai/i, "xAI"],
  [/localhost|127\.0\.0\.1/i, "Local (Ollama/LM Studio)"],
];

/** Si la clave es genérica `sk-`, el modelo ayuda a saber el servicio (ej. deepseek-chat). */
function sugerenciaModeloIA(modelo) {
  const valor = String(modelo ?? "").trim();
  if (/^deepseek/i.test(valor)) return { nombre: "DeepSeek", baseUrl: "https://api.deepseek.com" };
  if (/^(gpt-|o[1-9])/i.test(valor)) return { nombre: "OpenAI", baseUrl: "https://api.openai.com/v1" };
  return null;
}

function detectarProveedorIA(apiKey, baseUrl = "", modelo = "") {
  const clave = String(apiKey ?? "").trim();
  if (!clave) return null;
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const regla = REGLAS_IA.find((r) => r.prueba.test(clave));
  // Una Base URL propia convierte una clave desconocida en un proveedor compatible con OpenAI.
  const proveedor = regla?.proveedor ?? (base ? "openai" : null);
  if (!proveedor) return null;
  const pista = proveedor === "openai" && (!regla || regla.generico) ? sugerenciaModeloIA(modelo) : null;
  const url = proveedor === "openai" ? base || pista?.baseUrl || regla?.baseUrl || "https://api.openai.com/v1" : "";
  return {
    proveedor,
    nombre: NOMBRES_BASE_IA.find(([patron]) => patron.test(url))?.[1] || pista?.nombre || regla?.nombre || "Compatible con OpenAI",
    baseUrl: url,
  };
}

function leerConfig() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_CONFIG) || "{}");
  } catch {
    return {};
  }
}

function guardarConfig(c) {
  localStorage.setItem(CLAVE_CONFIG, JSON.stringify(c));
}

/** Encabezados con la configuración del navegador (PAT de Azure y conexión de IA). */
function cabeceras() {
  const c = leerConfig();
  const h = {};
  if (c.azurePat) h["X-Azure-Pat"] = c.azurePat;
  const detectado = c.ia?.apiKey ? detectarProveedorIA(c.ia.apiKey, c.ia.baseUrl, c.ia.modelo) : null;
  const proveedor = detectado?.proveedor || c.ia?.proveedor || "";
  if (c.ia?.apiKey && proveedor) {
    const ia = {
      ...c.ia,
      proveedor,
      nombre: detectado?.nombre || c.ia.nombre || "",
      baseUrl: c.ia.baseUrl || detectado?.baseUrl || "",
    };
    const bytes = new TextEncoder().encode(JSON.stringify(ia));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    h["X-IA-Config"] = btoa(bin);
  }
  return h;
}

const post = (cuerpo) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo ?? {}) });

async function pedirJSON(url, opciones = {}) {
  const r = await fetch(url, { ...opciones, headers: { ...(opciones.headers ?? {}), ...cabeceras() } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error del servidor (${r.status}).`);
  return j;
}

function mostrarError(texto) {
  const el = $("#error");
  el.textContent = texto || "";
  el.hidden = !texto;
}

function toast(texto, tipo = "ok") {
  let t = document.createElement("div");
  t.className = `toast ${tipo}`;
  t.textContent = texto;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------------------------------------------------------------- Configuración inicial

async function iniciar() {
  try {
    estado.config = await pedirJSON("/api/config");
    pintarEstados();
    await cargarProyectos();
  } catch (err) {
    mostrarError(err.message);
  }
}

function pintarEstados() {
  const c = leerConfig();
  const az = estado.config?.azure;
  const ia = estado.config?.ia;
  const azOk = Boolean(c.azurePat) || Boolean(az?.configurado);
  const detectado = c.ia?.apiKey ? detectarProveedorIA(c.ia.apiKey, c.ia.baseUrl, c.ia.modelo) : null;
  const iaOk = Boolean((c.ia?.apiKey && (detectado || c.ia?.proveedor)) || ia?.configurado);
  const nombreIA = detectado?.nombre || c.ia?.nombre || NOMBRES_IA[c.ia?.proveedor] || ia?.proveedor;
  const azEl = $("#estadoAzure");
  azEl.textContent = azOk ? `Azure · ${c.azurePat ? "PAT del navegador" : az?.proyecto || "OK"}` : "Azure sin configurar";
  azEl.className = `chip ${azOk ? "ok" : "mal"}`;
  const iaEl = $("#estadoIA");
  iaEl.textContent = iaOk ? `IA · ${nombreIA || "configurada"}` : "IA sin configurar";
  iaEl.className = `chip ${iaOk ? "ok" : "mal"}`;
  if (!azOk) mostrarError("Falta configurar Azure DevOps: use ⚙ Configuración o el archivo .env.");
  else if (!iaOk) mostrarError("Falta configurar la IA: use ⚙ Configuración o el archivo .env.");
}

// ---------------------------------------------------------------- Configuración (IA + Azure)

function abrirConfig() {
  const c = leerConfig();
  const ia = c.ia ?? {};
  $("#iaApiKey").value = ia.apiKey ?? "";
  $("#iaModelo").value = ia.modelo ?? "";
  $("#iaBaseUrl").value = ia.baseUrl ?? "";
  actualizarDeteccionIA();
  $("#azPat").value = c.azurePat ?? "";
  $("#azureActual").textContent = estado.config?.azure
    ? `Organización: ${estado.config.azure.url || "—"} · Proyecto: ${estado.config.azure.proyecto || "—"}`
    : "";
  $("#configError").hidden = true;
  $("#modalConfig").hidden = false;
}

function cerrarConfig() {
  $("#modalConfig").hidden = true;
}

function errorConfig(texto) {
  const el = $("#configError");
  el.textContent = texto || "";
  el.hidden = !texto;
}

/** Muestra en vivo qué proveedor se detecta con la clave y la Base URL escritas. */
function actualizarDeteccionIA() {
  const el = $("#iaProveedorDetectado");
  const apiKey = $("#iaApiKey").value.trim();
  if (!apiKey) {
    el.textContent = "El proveedor se detecta automáticamente al pegar la clave.";
    el.classList.remove("ok");
    return;
  }
  const detectado = detectarProveedorIA(apiKey, $("#iaBaseUrl").value, $("#iaModelo").value);
  if (!detectado) {
    el.textContent = "No se reconoce esta clave. Indique la Base URL del servicio (ej. https://api.deepseek.com).";
    el.classList.remove("ok");
    return;
  }
  el.textContent = `Proveedor detectado: ${detectado.nombre}`;
  el.classList.add("ok");
}

function guardarConfigForm(e) {
  e.preventDefault();
  const apiKey = $("#iaApiKey").value.trim();
  const modelo = $("#iaModelo").value.trim();
  const baseUrl = $("#iaBaseUrl").value.trim();
  const detectado = detectarProveedorIA(apiKey, baseUrl, modelo);
  const previa = leerConfig().ia ?? {};
  const mismaClave = apiKey === (previa.apiKey ?? "");
  const azurePat = $("#azPat").value.trim();
  if (!apiKey && !estado.config?.ia?.configurado) return errorConfig("Indique la API key de la IA.");
  if (apiKey && !detectado && !(previa.proveedor && mismaClave)) {
    return errorConfig("No se reconoce el proveedor de esa API key. Revise la clave o indique la Base URL (ej. https://api.deepseek.com).");
  }
  if (!azurePat && !estado.config?.azure?.configurado) return errorConfig("Indique el PAT de Azure DevOps.");
  const ia = {
    proveedor: detectado?.proveedor || (mismaClave ? previa.proveedor : "") || "",
    apiKey,
    modelo,
    baseUrl: baseUrl || detectado?.baseUrl || "",
    nombre: detectado?.nombre || "",
  };
  guardarConfig({ ia, azurePat });
  cerrarConfig();
  iniciar().then(() => toast("Configuración guardada"));
}

function olvidarConfig() {
  localStorage.removeItem(CLAVE_CONFIG);
  cerrarConfig();
  iniciar().then(() => toast("Configuración olvidada"));
}

async function cargarProyectos() {
  const r = await pedirJSON("/api/proyectos");
  estado.proyectos = r.proyectos ?? [];
  const sel = $("#selProyecto");
  sel.innerHTML = estado.proyectos.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  if (r.actual) sel.value = r.actual;
  await cargarSprintsAreas();
}

async function cargarSprintsAreas() {
  const proyecto = $("#selProyecto").value;
  if (!proyecto) return;
  const [s, a] = await Promise.all([
    pedirJSON(`/api/proyectos/${encodeURIComponent(proyecto)}/sprints`),
    pedirJSON(`/api/proyectos/${encodeURIComponent(proyecto)}/areas`),
  ]);
  estado.sprints = s.sprints ?? [];
  estado.areas = a.areas ?? [];
  $("#selSprint").innerHTML = estado.sprints
    .map((x) => `<option value="${esc(x.ruta)}" ${x.actual ? "selected" : ""}>${esc(x.nombre)}${x.actual ? " · actual" : ""}${x.inicio ? ` (${esc(x.inicio)} → ${esc(x.fin)})` : ""}</option>`)
    .join("");
  $("#selArea").innerHTML = `<option value="">Todas las áreas</option>${estado.areas.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}`;
  $("#listaHUs").innerHTML = "";
  $("#btnAnalizarSprint").disabled = true;
}

// ---------------------------------------------------------------- Listar HUs del sprint

async function listarHUs() {
  mostrarError("");
  const proyecto = $("#selProyecto").value;
  const sprint = $("#selSprint").value;
  const area = $("#selArea").value;
  if (!sprint) return mostrarError("Seleccione un sprint.");
  const b = $("#btnListarHUs");
  b.disabled = true;
  b.textContent = "Consultando…";
  try {
    const r = await pedirJSON(`/api/azure/sprint/hus?${new URLSearchParams({ proyecto, ruta: sprint, area })}`);
    estado.hus = r.hus ?? [];
    estado.sprintNombre = $("#selSprint").selectedOptions[0]?.textContent ?? "";
    pintarListaHUs();
  } catch (err) {
    mostrarError(err.message);
  } finally {
    b.disabled = false;
    b.textContent = "Listar HUs";
  }
}

function pintarListaHUs() {
  const cont = $("#listaHUs");
  if (!estado.hus.length) {
    cont.innerHTML = '<p class="ayuda">El sprint no tiene HUs en esa área.</p>';
    $("#btnAnalizarSprint").disabled = true;
    return;
  }
  cont.innerHTML = `
    <div class="lista-cabecera">
      <label class="check"><input type="checkbox" id="selTodas" checked> <span>${estado.hus.length} HU(s)</span></label>
      <button type="button" class="enlace" id="btnLimpiarSel">Limpiar</button>
    </div>
    <div class="lista-scroll">
      ${estado.hus
        .map(
          (h) => `<label class="hu-item">
            <input type="checkbox" data-hu="${h.id}" checked>
            <span class="hu-id">#${esc(h.id)}</span>
            <span class="hu-titulo" title="${esc(h.titulo)}">${esc(h.titulo)}</span>
            <span class="hu-meta">${esc(h.estado || "")}${h.casos ? ` · ${h.casos} caso(s)` : ""}</span>
          </label>`,
        )
        .join("")}
    </div>`;
  $("#selTodas").addEventListener("change", (e) => {
    cont.querySelectorAll("[data-hu]").forEach((c) => (c.checked = e.target.checked));
    actualizarBotonSprint();
  });
  $("#btnLimpiarSel").addEventListener("click", () => {
    cont.querySelectorAll("[data-hu]").forEach((c) => (c.checked = false));
    $("#selTodas").checked = false;
    actualizarBotonSprint();
  });
  cont.querySelectorAll("[data-hu]").forEach((c) => c.addEventListener("change", actualizarBotonSprint));
  actualizarBotonSprint();
}

function seleccionadas() {
  return [...document.querySelectorAll("[data-hu]")].filter((c) => c.checked).map((c) => Number(c.dataset.hu));
}

function actualizarBotonSprint() {
  const n = seleccionadas().length;
  const b = $("#btnAnalizarSprint");
  b.disabled = !n || estado.analizando;
  b.textContent = n ? `Analizar ${n} HU(s)` : "Analizar seleccionadas";
}

// ---------------------------------------------------------------- Análisis

async function analizarHU(id) {
  const r = await pedirJSON("/api/analizar-hu", post({ id }));
  const existente = estado.resultados.findIndex((x) => x.hu.id === r.hu.id);
  if (existente >= 0) estado.resultados[existente] = r;
  else estado.resultados.push(r);
  return r;
}

async function analizarUna() {
  const id = Number($("#huId").value);
  if (!Number.isInteger(id) || id <= 0) return mostrarError("Escriba un ID de HU válido.");
  mostrarError("");
  const b = $("#btnAnalizarHU");
  b.disabled = true;
  b.textContent = "Analizando…";
  try {
    await analizarHU(id);
    render();
    toast(`HU #${id} analizada`);
  } catch (err) {
    mostrarError(err.message);
  } finally {
    b.disabled = false;
    b.textContent = "Analizar";
  }
}

async function analizarSeleccionadas() {
  const ids = seleccionadas();
  if (!ids.length) return mostrarError("Seleccione al menos una HU.");
  if (estado.analizando) return;
  estado.analizando = true;
  mostrarError("");
  $("#progreso").hidden = false;
  const b = $("#btnAnalizarSprint");
  b.disabled = true;
  try {
    for (let i = 0; i < ids.length; i++) {
      $("#textoProgreso").textContent = `Analizando HU #${ids[i]} (${i + 1} de ${ids.length})…`;
      $("#barraProgreso").style.width = `${Math.round((i / ids.length) * 100)}%`;
      try {
        await analizarHU(ids[i]);
        render();
      } catch (err) {
        toast(`HU #${ids[i]}: ${err.message}`, "error");
      }
    }
    $("#barraProgreso").style.width = "100%";
    $("#textoProgreso").textContent = "Análisis terminado.";
  } finally {
    estado.analizando = false;
    setTimeout(() => ($("#progreso").hidden = true), 1500);
    actualizarBotonSprint();
  }
}

async function analizarArchivo() {
  const file = $("#archivo").files?.[0];
  if (!file) return mostrarError("Seleccione un archivo Word, Excel o PDF.");
  mostrarError("");
  const b = $("#btnAnalizarArchivo");
  b.disabled = true;
  b.textContent = "Leyendo archivo…";
  $("#archivoInfo").textContent = "";
  try {
    const { tipo, texto } = await window.extraerTexto(file);
    if (!texto.trim()) throw new Error("No se pudo extraer texto del archivo (¿PDF escaneado o vacío?).");
    $("#archivoInfo").textContent = `${file.name} · ${tipo} · ${texto.length.toLocaleString("es")} caracteres leídos.`;
    b.textContent = "Analizando…";
    const { datos, meta } = await pedirJSON("/api/analizar-texto", post({ texto }));
    const r = {
      hu: { id: null, titulo: file.name, tipo, estado: "", area: "", iteracion: "", enlace: "" },
      datos,
      meta,
      origen: "archivo",
    };
    const i = estado.resultados.findIndex((x) => x.origen === "archivo" && x.hu.titulo === file.name);
    if (i >= 0) estado.resultados[i] = r;
    else estado.resultados.push(r);
    render();
    toast(`Archivo analizado: ${file.name}`);
  } catch (err) {
    mostrarError(err.message);
  } finally {
    b.disabled = false;
    b.textContent = "Analizar archivo";
  }
}

// ---------------------------------------------------------------- Render

function render() {
  $("#vacio").hidden = estado.resultados.length > 0;
  renderResumen();
  renderTarjetas();
}

function renderResumen() {
  const cont = $("#resumen");
  if (!estado.resultados.length) {
    cont.hidden = true;
    return;
  }
  const totalPreguntas = estado.resultados.reduce((n, r) => n + r.datos.ambiguedades_y_preguntas.length, 0);
  const conPreguntas = estado.resultados.filter((r) => r.datos.ambiguedades_y_preguntas.length).length;
  const sinPreguntas = estado.resultados.length - conPreguntas;
  cont.hidden = false;
  cont.innerHTML = `
    <div class="kpi"><b>${estado.resultados.length}</b><span>HU(s) analizadas</span></div>
    <div class="kpi"><b>${totalPreguntas}</b><span>Preguntas</span></div>
    <div class="kpi"><b>${conPreguntas}</b><span>HU(s) con ambigüedades</span></div>
    <div class="kpi"><b>${sinPreguntas}</b><span>HU(s) sin ambigüedades</span></div>
    <div class="acciones-resumen">
      <button class="btn secundario mini" id="btnCopiarTodo">Copiar todo</button>
      <button class="btn secundario mini" id="btnJSON">JSON</button>
      <button class="btn secundario mini" id="btnCSV">CSV</button>
      <button class="btn secundario mini" id="btnWordLote">Word del lote</button>
      <button class="btn secundario mini" id="btnLimpiar">Limpiar</button>
    </div>`;
  $("#btnCopiarTodo").addEventListener("click", copiarTodo);
  $("#btnJSON").addEventListener("click", exportarJSON);
  $("#btnCSV").addEventListener("click", exportarCSV);
  $("#btnWordLote").addEventListener("click", descargarWordLote);
  $("#btnLimpiar").addEventListener("click", () => {
    estado.resultados = [];
    render();
  });
}

function agrupar(datos) {
  const criterios = datos.criterios_aceptacion ?? [];
  const descripcion = new Map(criterios.map((c) => [c.id, c.descripcion]));
  const grupos = new Map();
  for (const a of datos.ambiguedades_y_preguntas ?? []) {
    const clave = a.criterio || "General";
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(a.pregunta);
  }
  const orden = [...criterios.map((c) => c.id), "General"];
  return [...grupos.entries()]
    .sort(([a], [b]) => {
      const ia = orden.indexOf(a);
      const ib = orden.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })
    .map(([id, preguntas]) => ({ id, descripcion: descripcion.get(id) ?? "", preguntas }));
}

function renderTarjetas() {
  const cont = $("#tarjetas");
  cont.innerHTML = estado.resultados
    .map((r, i) => {
      const grupos = agrupar(r.datos);
      const n = r.datos.ambiguedades_y_preguntas.length;
      const esArchivo = r.origen === "archivo" || r.hu.id == null;
      return `<article class="tarjeta ${n ? "con-hallazgos" : "sin-hallazgos"}">
        <header class="tarjeta-head">
          <div>
            <h3>${esArchivo ? `📄 ${esc(r.hu.titulo)}` : `<a href="${esc(r.hu.enlace)}" target="_blank" rel="noopener">#${esc(r.hu.id)}</a> · ${esc(r.hu.titulo)}`}</h3>
            <p class="meta">${esArchivo ? `Archivo ${esc(r.hu.tipo || "")}` : `${esc(r.hu.tipo || "")} · ${esc(r.hu.estado || "")}${r.hu.area ? ` · ${esc(r.hu.area)}` : ""}${r.hu.iteracion ? ` · ${esc(r.hu.iteracion.split("\\").pop())}` : ""}`}</p>
          </div>
          <span class="contador ${n ? "alerta" : "ok"}">${n} pregunta(s)</span>
        </header>
        ${r.datos.resumen_requerimiento ? `<p class="resumen-txt">${esc(r.datos.resumen_requerimiento)}</p>` : ""}
        ${
          r.datos.es_entrada_valida === false
            ? `<p class="aviso">La IA no reconoció un requerimiento válido: ${esc(r.datos.motivo_rechazo || "sin motivo")}</p>`
            : n
              ? grupos
                  .map(
                    (g) => `<section class="grupo">
                      <h4>${esc(g.id)}${g.descripcion ? ` · <span>${esc(g.descripcion)}</span>` : ""}</h4>
                      <ol>${g.preguntas.map((q) => `<li>${esc(q)}</li>`).join("")}</ol>
                    </section>`,
                  )
                  .join("")
              : '<p class="sin-ambiguedades">Sin ambigüedades detectadas en esta HU.</p>'
        }
        ${r.datos.supuestos?.length ? `<details class="supuestos"><summary>Supuestos (${r.datos.supuestos.length})</summary><ul>${r.datos.supuestos.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></details>` : ""}
        <footer class="tarjeta-pie">
          <button class="btn secundario mini" data-copiar="${i}">Copiar</button>
          <button class="btn secundario mini" data-word="${i}">Word</button>
        </footer>
      </article>`;
    })
    .join("");

  cont.querySelectorAll("[data-copiar]").forEach((b) => b.addEventListener("click", () => copiarItem(Number(b.dataset.copiar))));
  cont.querySelectorAll("[data-word]").forEach((b) => b.addEventListener("click", () => descargarWord(Number(b.dataset.word))));
}

// ---------------------------------------------------------------- Exportar

function textoItem(r) {
  const lineas = [r.hu.id ? `HU #${r.hu.id} · ${r.hu.titulo}` : `Archivo: ${r.hu.titulo}`, ""];
  for (const g of agrupar(r.datos)) {
    lineas.push(`${g.id}${g.descripcion ? ` · ${g.descripcion}` : ""}`);
    g.preguntas.forEach((q, k) => lineas.push(`  ${k + 1}. ${q}`));
    lineas.push("");
  }
  return lineas.join("\n").trim();
}

async function copiarItem(i) {
  const r = estado.resultados[i];
  if (!r) return;
  await navigator.clipboard.writeText(textoItem(r));
  toast("Preguntas copiadas");
}

async function copiarTodo() {
  const texto = estado.resultados.map(textoItem).join("\n\n");
  await navigator.clipboard.writeText(texto);
  toast("Todo copiado");
}

function descargar(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportarJSON() {
  descargar("ambiguedades.json", JSON.stringify(estado.resultados, null, 2), "application/json");
}

function exportarCSV() {
  const filas = [["HU", "Titulo", "Criterio", "Pregunta"]];
  for (const r of estado.resultados) for (const a of r.datos.ambiguedades_y_preguntas) filas.push([r.hu.id ?? "Archivo", r.hu.titulo, a.criterio, a.pregunta]);
  const csv = filas.map((f) => f.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  descargar("ambiguedades.csv", `\uFEFF${csv}`, "text/csv;charset=utf-8");
}

async function descargarWord(i) {
  const r = estado.resultados[i];
  if (!r) return;
  try {
    const opciones = post({ datos: { ...r.datos, hu: r.hu }, modo: "criterio" });
    const resp = await fetch("/api/docx", { ...opciones, headers: { ...(opciones.headers ?? {}), ...cabeceras() } });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `Error del servidor (${resp.status}).`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: `ambiguedades-HU-${r.hu.id ?? "archivo"}.docx` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    mostrarError(err.message);
  }
}

async function descargarWordLote() {
  const preguntas = estado.resultados.flatMap((r) =>
    r.datos.ambiguedades_y_preguntas.map((a) => ({ hu_id: r.hu.id, hu_titulo: r.hu.titulo, criterio: a.criterio, pregunta: a.pregunta })),
  );
  const supuestos = [...new Set(estado.resultados.flatMap((r) => r.datos.supuestos ?? []))];
  const datos = {
    lote: {
      sprint: { nombre: estado.sprintNombre || "HUs analizadas" },
      hus: estado.resultados.map((r) => ({ id: r.hu.id, titulo: r.hu.titulo })),
    },
    ambiguedades_y_preguntas: preguntas,
    supuestos,
  };
  try {
    const opciones = post({ datos });
    const resp = await fetch("/api/docx-lote", { ...opciones, headers: { ...(opciones.headers ?? {}), ...cabeceras() } });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `Error del servidor (${resp.status}).`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: "ambiguedades-sprint.docx" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    mostrarError(err.message);
  }
}

// ---------------------------------------------------------------- Eventos

$("#tabHU").addEventListener("click", () => cambiarModo("hu"));
$("#tabSprint").addEventListener("click", () => cambiarModo("sprint"));
$("#tabArchivo").addEventListener("click", () => cambiarModo("archivo"));
$("#btnAnalizarHU").addEventListener("click", analizarUna);
$("#huId").addEventListener("keydown", (e) => e.key === "Enter" && analizarUna());
$("#btnListarHUs").addEventListener("click", listarHUs);
$("#btnAnalizarSprint").addEventListener("click", analizarSeleccionadas);
$("#btnAnalizarArchivo").addEventListener("click", analizarArchivo);
$("#selProyecto").addEventListener("change", () => cargarSprintsAreas().catch((e) => mostrarError(e.message)));
$("#selSprint").addEventListener("change", () => {
  $("#listaHUs").innerHTML = "";
  $("#btnAnalizarSprint").disabled = true;
});

function cambiarModo(modo) {
  $("#tabHU").classList.toggle("activo", modo === "hu");
  $("#tabSprint").classList.toggle("activo", modo === "sprint");
  $("#tabArchivo").classList.toggle("activo", modo === "archivo");
  $("#modoHU").hidden = modo !== "hu";
  $("#modoSprint").hidden = modo !== "sprint";
  $("#modoArchivo").hidden = modo !== "archivo";
}

$("#btnConfig").addEventListener("click", abrirConfig);
document.querySelectorAll("[data-cerrar-config]").forEach((el) => el.addEventListener("click", cerrarConfig));
$("#formConfig").addEventListener("submit", guardarConfigForm);
$("#btnOlvidar").addEventListener("click", olvidarConfig);
$("#iaApiKey").addEventListener("input", actualizarDeteccionIA);
$("#iaBaseUrl").addEventListener("input", actualizarDeteccionIA);
$("#iaModelo").addEventListener("input", actualizarDeteccionIA);

iniciar();
