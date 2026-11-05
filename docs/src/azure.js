// Cliente de Azure DevOps para el navegador (GitHub Pages). Sin servidor: usa el PAT y la
// organización/proyecto guardados en este navegador.

export function leerAzure() {
  try {
    const c = JSON.parse(localStorage.getItem("qa_amb_config") || "{}");
    return c.azure ?? {};
  } catch {
    return {};
  }
}

const limpio = (v) => String(v ?? "").trim().replace(/\/+$/, "");

function base() {
  const a = leerAzure();
  if (!a.org || !a.project || !a.pat) throw new Error("Configure la organización, el proyecto y el PAT en ⚙ Configuración.");
  return `${limpio(a.org)}/${encodeURIComponent(a.project)}`;
}

function cabeceras(extra = {}) {
  const a = leerAzure();
  return {
    Authorization: "Basic " + btoa(":" + a.pat),
    "Content-Type": "application/json",
    ...extra,
  };
}

async function pedir(url, opciones = {}) {
  const r = await fetch(url, { ...opciones, headers: cabeceras(opciones.headers ?? {}) });
  if (!r.ok) {
    let mensaje = `Azure DevOps respondió ${r.status}.`;
    try {
      const j = await r.json();
      mensaje = j.message || mensaje;
    } catch { /* sin JSON */ }
    if (r.status === 401 || r.status === 203) mensaje = "El PAT de Azure es inválido, venció o no tiene permisos de lectura.";
    throw new Error(mensaje);
  }
  return r;
}

export async function listarProyectos() {
  const a = leerAzure();
  if (!a.org || !a.pat) throw new Error("Configure la organización y el PAT en ⚙ Configuración.");
  const r = await pedir(`${limpio(a.org)}/_apis/projects?api-version=7.1&$top=500`);
  const j = await r.json();
  return { proyectos: (j.value ?? []).map((p) => p.name).sort((x, y) => x.localeCompare(y, "es")), actual: a.project || "" };
}

export async function listarSprints() {
  const r = await pedir(`${base()}/_apis/wit/classificationnodes/iterations?$depth=10&api-version=7.1`);
  const raiz = await r.json();
  const hoy = new Date().toISOString().slice(0, 10);
  const sprints = [];
  const recorrer = (nodo, ruta) => {
    const actual = ruta ? `${ruta}\\${nodo.name}` : nodo.name;
    const inicio = nodo.attributes?.startDate?.slice(0, 10);
    const fin = nodo.attributes?.finishDate?.slice(0, 10);
    if (ruta) sprints.push({ ruta: actual, nombre: nodo.name, inicio: inicio ?? "", fin: fin ?? "", actual: Boolean(inicio && fin && inicio <= hoy && hoy <= fin) });
    for (const hijo of nodo.children ?? []) recorrer(hijo, actual);
  };
  recorrer(raiz, "");
  sprints.sort((a, b) => Boolean(b.inicio) - Boolean(a.inicio) || b.inicio.localeCompare(a.inicio) || a.ruta.localeCompare(b.ruta, "es"));
  return [...sprints, { ruta: raiz.name, nombre: `Todo el proyecto ${raiz.name}`, inicio: "", fin: "", actual: false, todo: true }];
}

export async function listarAreas() {
  const r = await pedir(`${base()}/_apis/wit/classificationnodes/areas?$depth=10&api-version=7.1`);
  const raiz = await r.json();
  const areas = [];
  const recorrer = (nodo, ruta) => {
    const actual = ruta ? `${ruta}\\${nodo.name}` : nodo.name;
    areas.push(actual);
    for (const hijo of nodo.children ?? []) recorrer(hijo, actual);
  };
  recorrer(raiz, "");
  return areas.sort((a, b) => a.localeCompare(b, "es"));
}

async function wiql(query) {
  const r = await pedir(`${base()}/_apis/wit/wiql?api-version=7.1`, { method: "POST", body: JSON.stringify({ query }) });
  const j = await r.json();
  return (j.workItems ?? []).map((w) => w.id);
}

/** HUs (User Story / PBI) de un sprint; opcionalmente filtradas por área. */
export async function historiasDelSprint(ruta, area = "") {
  if (!String(ruta ?? "").trim()) throw new Error("Seleccione un sprint.");
  const rutaSegura = String(ruta).replace(/'/g, "''");
  const areaSegura = String(area ?? "").replace(/'/g, "''");
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project
    AND [System.WorkItemType] IN ('User Story', 'Product Backlog Item')
    AND [System.IterationPath] UNDER '${rutaSegura}'
    ${areaSegura ? `AND [System.AreaPath] UNDER '${areaSegura}'` : ""}
    AND [System.State] <> 'Removed'
    ORDER BY [System.Id]`;
  const ids = await wiql(query);
  const historias = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await pedir(`${base()}/_apis/wit/workitems?ids=${ids.slice(i, i + 200).join(",")}&api-version=7.1`);
    const j = await r.json();
    for (const w of j.value ?? []) {
      const f = w.fields ?? {};
      historias.push({
        id: w.id,
        titulo: f["System.Title"] ?? "",
        tipo: f["System.WorkItemType"] ?? "",
        estado: f["System.State"] ?? "",
        asignado: f["System.AssignedTo"]?.displayName ?? "",
        area: f["System.AreaPath"] ?? "",
        iteracion: f["System.IterationPath"] ?? "",
        tags: String(f["System.Tags"] ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean),
        enlace: w._links?.html?.href ?? "",
      });
    }
  }
  return historias;
}

/** Convierte el HTML de Azure a texto legible (sin imágenes ni scripts). */
export function htmlATexto(html) {
  return String(html ?? "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** HU completa (título, descripción y criterios de aceptación) lista para analizar. */
export async function obtenerHU(id) {
  const r = await pedir(`${base()}/_apis/wit/workitems/${encodeURIComponent(id)}?$expand=all&api-version=7.1`);
  const w = await r.json();
  const f = w.fields ?? {};
  const tipo = f["System.WorkItemType"] ?? "Work item";
  const titulo = f["System.Title"] ?? "";
  const secciones = [
    ["Descripción", f["System.Description"]],
    ["Criterios de aceptación", f["Microsoft.VSTS.Common.AcceptanceCriteria"]],
  ]
    .map(([nombre, html]) => ({ nombre, texto: htmlATexto(html) }))
    .filter((s) => s.texto);
  return {
    id: w.id,
    titulo,
    tipo,
    estado: f["System.State"] ?? "",
    asignado: f["System.AssignedTo"]?.displayName ?? "",
    area: f["System.AreaPath"] ?? "",
    iteracion: f["System.IterationPath"] ?? "",
    enlace: w._links?.html?.href ?? "",
    texto: [`${tipo} #${w.id}: ${titulo}`, ...secciones.map((s) => `${s.nombre}:\n${s.texto}`)].join("\n\n"),
  };
}
