import { listarProyectos, listarSprints, listarAreas, historiasDelSprint, obtenerHU } from "./src/azure.js";
import { analizarAmbiguedades, probarIA } from "./src/ambiguedades.js";
import { extraerTexto } from "./src/archivos.js";

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CLAVE = "qa_amb_config";
const NOMBRES_IA = { gemini: "Gemini", anthropic: "Claude", openai: "OpenAI compatible" };

const estado = {
  proyectos: [],
  sprints: [],
  areas: [],
  hus: [],
  resultados: [],
  sprintNombre: "",
  analizando: false,
};

function leerConfig() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE) || "{}");
  } catch {
    return {};
  }
}

function guardarConfig(c) {
  localStorage.setItem(CLAVE, JSON.stringify(c));
}

function mostrarError(texto) {
  const el = $("#error");
  el.textContent = texto || "";
  el.hidden = !texto;
}

function toast(texto, tipo = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${tipo}`;
  t.textContent = texto;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------------------------------------------------------------- Inicio

async function iniciar() {
  mostrarError("");
  const c = leerConfig();
  pintarEstados();
  if (!c.azure?.org || !c.azure?.project || !c.azure?.pat || !c.ia?.proveedor || !c.ia?.apiKey) {
    abrirConfig();
    mostrarError("Complete la configuración de Azure y de la IA para empezar.");
    return;
  }
  try {
    await cargarProyectos();
  } catch (err) {
    mostrarError(err.message);
  }
}

function pintarEstados() {
  const c = leerConfig();
  const azOk = Boolean(c.azure?.org && c.azure?.project && c.azure?.pat);
  const iaOk = Boolean(c.ia?.proveedor && c.ia?.apiKey);
  const azEl = $("#estadoAzure");
  azEl.textContent = azOk ? `Azure · ${c.azure.project}` : "Azure sin configurar";
  azEl.className = `chip ${azOk ? "ok" : "mal"}`;
  const iaEl = $("#estadoIA");
  iaEl.textContent = iaOk ? `IA · ${NOMBRES_IA[c.ia.proveedor] ?? c.ia.proveedor}` : "IA sin configurar";
  iaEl.className = `chip ${iaOk ? "ok" : "mal"}`;
}

async function cargarProyectos() {
  const r = await listarProyectos();
  estado.proyectos = r.proyectos ?? [];
  const sel = $("#selProyecto");
  sel.innerHTML = estado.proyectos.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  if (r.actual) sel.value = r.actual;
  await cargarSprintsAreas();
}

async function cargarSprintsAreas() {
  const [s, a] = await Promise.all([listarSprints(), listarAreas()]);
  estado.sprints = s;
  estado.areas = a;
  $("#selSprint").innerHTML = estado.sprints
    .map((x) => `<option value="${esc(x.ruta)}" ${x.actual ? "selected" : ""}>${esc(x.nombre)}${x.actual ? " · actual" : ""}${x.inicio ? ` (${esc(x.inicio)} → ${esc(x.fin)})` : ""}</option>`)
    .join("");
  $("#selArea").innerHTML = `<option value="">Todas las áreas</option>${estado.areas.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}`;
  $("#listaHUs").innerHTML = "";
  $("#btnAnalizarSprint").disabled = true;
}

// ---------------------------------------------------------------- HUs del sprint

async function listarHUs() {
  mostrarError("");
  const sprint = $("#selSprint").value;
  const area = $("#selArea").value;
  if (!sprint) return mostrarError("Seleccione un sprint.");
  const b = $("#btnListarHUs");
  b.disabled = true;
  b.textContent = "Consultando…";
  try {
    estado.hus = await historiasDelSprint(sprint, area);
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
            <span class="hu-meta">${esc(h.estado || "")}${h.area ? ` · ${esc(h.area.split("\\").pop())}` : ""}</span>
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
  const hu = await obtenerHU(id);
  if (!String(hu.texto ?? "").trim()) throw new Error(`La HU #${id} no tiene descripción ni criterios para analizar.`);
  const { datos, meta } = await analizarAmbiguedades({ texto: hu.texto });
  const r = { hu, datos, meta };
  const i = estado.resultados.findIndex((x) => x.hu.id === hu.id);
  if (i >= 0) estado.resultados[i] = r;
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
  $("#btnAnalizarSprint").disabled = true;
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
    const { tipo, texto } = await extraerTexto(file);
    if (!texto.trim()) throw new Error("No se pudo extraer texto del archivo (¿PDF escaneado o vacío?).");
    $("#archivoInfo").textContent = `${file.name} · ${tipo} · ${texto.length.toLocaleString("es")} caracteres leídos.`;
    b.textContent = "Analizando…";
    const { datos, meta } = await analizarAmbiguedades({ texto });
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
  const total = estado.resultados.reduce((n, r) => n + r.datos.ambiguedades_y_preguntas.length, 0);
  const con = estado.resultados.filter((r) => r.datos.ambiguedades_y_preguntas.length).length;
  cont.hidden = false;
  cont.innerHTML = `
    <div class="kpi"><b>${estado.resultados.length}</b><span>HU(s) analizadas</span></div>
    <div class="kpi"><b>${total}</b><span>Preguntas</span></div>
    <div class="kpi"><b>${con}</b><span>HU(s) con ambigüedades</span></div>
    <div class="kpi"><b>${estado.resultados.length - con}</b><span>HU(s) sin ambigüedades</span></div>
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
    .sort(([a], [b]) => (orden.indexOf(a) < 0 ? 999 : orden.indexOf(a)) - (orden.indexOf(b) < 0 ? 999 : orden.indexOf(b)))
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
  await navigator.clipboard.writeText(estado.resultados.map(textoItem).join("\n\n"));
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

function docItem(r) {
  const grupos = agrupar(r.datos);
  const encabezado = r.hu.id ? `HU #${esc(r.hu.id)}` : "Archivo";
  return `<html><head><meta charset="utf-8"><title>Ambigüedades ${encabezado}</title>
  <style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}h1{font-size:16pt;color:#0b5fa5}h2{font-size:12pt;color:#0b5fa5}li{margin:4px 0}</style></head><body>
  <h1>Ambigüedades y preguntas · ${encabezado}</h1>
  <p><b>${esc(r.hu.titulo)}</b><br/>${esc(r.hu.estado || "")}${r.hu.area ? ` · ${esc(r.hu.area)}` : ""}</p>
  ${r.datos.resumen_requerimiento ? `<p>${esc(r.datos.resumen_requerimiento)}</p>` : ""}
  ${grupos.map((g) => `<h2>${esc(g.id)}${g.descripcion ? ` · ${esc(g.descripcion)}` : ""}</h2><ol>${g.preguntas.map((q) => `<li>${esc(q)}</li>`).join("")}</ol>`).join("")}
  ${r.datos.supuestos?.length ? `<h2>Supuestos</h2><ul>${r.datos.supuestos.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
  </body></html>`;
}

function descargarWord(i) {
  const r = estado.resultados[i];
  if (!r) return;
  descargar(`ambiguedades-HU-${r.hu.id}.doc`, docItem(r), "application/msword");
}

function descargarWordLote() {
  const filas = estado.resultados.flatMap((r) =>
    r.datos.ambiguedades_y_preguntas.map((a) => `<tr><td>#${esc(r.hu.id)}</td><td>${esc(a.criterio)}</td><td>${esc(a.pregunta)}</td></tr>`),
  );
  const html = `<html><head><meta charset="utf-8"><title>Ambigüedades del lote</title>
  <style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}th{background:#eef4fb}</style></head><body>
  <h1>Ambigüedades y preguntas del lote</h1>
  <p>${esc(estado.sprintNombre || "HUs analizadas")} · ${estado.resultados.length} HU(s)</p>
  <table><thead><tr><th>HU</th><th>Criterio</th><th>Pregunta</th></tr></thead><tbody>${filas.join("")}</tbody></table>
  </body></html>`;
  descargar("ambiguedades-sprint.doc", html, "application/msword");
}

// ---------------------------------------------------------------- Configuración

function abrirConfig() {
  const c = leerConfig();
  const az = c.azure ?? {};
  const ia = c.ia ?? {};
  $("#azOrg").value = az.org || "https://dev.azure.com/arsprimera";
  $("#azProyecto").value = az.project || "Proyectos 2026";
  $("#azPat").value = az.pat ?? "";
  $("#iaProveedor").value = ia.proveedor || "gemini";
  $("#iaApiKey").value = ia.apiKey ?? "";
  $("#iaModelo").value = ia.modelo ?? "";
  $("#iaBaseUrl").value = ia.baseUrl ?? "";
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

function guardarConfigForm(e) {
  e.preventDefault();
  const azure = {
    org: $("#azOrg").value.trim(),
    project: $("#azProyecto").value.trim(),
    pat: $("#azPat").value.trim(),
  };
  const ia = {
    proveedor: $("#iaProveedor").value,
    apiKey: $("#iaApiKey").value.trim(),
    modelo: $("#iaModelo").value.trim(),
    baseUrl: $("#iaBaseUrl").value.trim(),
  };
  if (!azure.org || !azure.project) return errorConfig("Indique la organización y el proyecto de Azure.");
  if (!azure.pat) return errorConfig("Indique el PAT de Azure.");
  if (!ia.apiKey) return errorConfig("Indique la API key de la IA.");
  guardarConfig({ azure, ia });
  cerrarConfig();
  iniciar().then(() => toast("Configuración guardada"));
}

function olvidarConfig() {
  localStorage.removeItem(CLAVE);
  cerrarConfig();
  iniciar().then(() => toast("Configuración olvidada"));
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
$("#btnConfig").addEventListener("click", abrirConfig);
document.querySelectorAll("[data-cerrar-config]").forEach((el) => el.addEventListener("click", cerrarConfig));
$("#formConfig").addEventListener("submit", guardarConfigForm);
$("#btnOlvidar").addEventListener("click", olvidarConfig);
$("#btnProbarIA").addEventListener("click", async () => {
  const ia = {
    proveedor: $("#iaProveedor").value,
    apiKey: $("#iaApiKey").value.trim(),
    modelo: $("#iaModelo").value.trim(),
    baseUrl: $("#iaBaseUrl").value.trim(),
  };
  const el = $("#iaPrueba");
  el.textContent = "Probando…";
  try {
    const r = await probarIA(ia);
    el.textContent = `Conexión OK (${r.modelo}): ${String(r.texto || "").trim().slice(0, 60)}`;
  } catch (err) {
    el.textContent = `Error: ${err.message}`;
  }
});
$("#selSprint").addEventListener("change", () => {
  $("#listaHUs").innerHTML = "";
  $("#btnAnalizarSprint").disabled = true;
});
$("#selProyecto").addEventListener("change", async () => {
  const c = leerConfig();
  c.azure = { ...(c.azure ?? {}), project: $("#selProyecto").value };
  guardarConfig(c);
  pintarEstados();
  try {
    await cargarSprintsAreas();
  } catch (err) {
    mostrarError(err.message);
  }
});

function cambiarModo(modo) {
  $("#tabHU").classList.toggle("activo", modo === "hu");
  $("#tabSprint").classList.toggle("activo", modo === "sprint");
  $("#tabArchivo").classList.toggle("activo", modo === "archivo");
  $("#modoHU").hidden = modo !== "hu";
  $("#modoSprint").hidden = modo !== "sprint";
  $("#modoArchivo").hidden = modo !== "archivo";
}

iniciar();
