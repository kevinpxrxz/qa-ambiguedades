// Cliente de la API REST de Azure DevOps (Services en la nube o Server on-premise) autenticado con PAT.
import { AsyncLocalStorage } from "node:async_hooks";
import { htmlATexto, extraerTextoDocx } from "./docx.js";

// PAT del usuario de la solicitud en curso (versión en la nube: cada persona usa su propio token,
// como en el dashboard). Sin PAT de usuario se usa AZDO_PAT del .env.
const patDeSolicitud = new AsyncLocalStorage();
export const conPAT = (pat, fn) => patDeSolicitud.run(pat, fn);

const lista = (v) =>
  String(v ?? "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

function config() {
  return {
    url: (process.env.AZDO_ORG_URL || "").trim().replace(/\/+$/, ""),
    proyecto: (process.env.AZDO_PROJECT || "").trim(),
    pat: (patDeSolicitud.getStore() || process.env.AZDO_PAT || "").trim(),
    apiVersion: (process.env.AZDO_API_VERSION || "7.1").trim(),
    tipoCaso: (process.env.AZDO_TIPO_CASO_PRUEBA || "Test Case").trim(),
    tagAutomatizado: (process.env.AZDO_TAG_AUTOMATIZADO || "Automatizado").trim(),
    tagsCasos: lista(process.env.AZDO_TAGS_CASOS),
    planId: (process.env.AZDO_TEST_PLAN_ID || "").trim(),
    suiteId: (process.env.AZDO_TEST_SUITE_ID || "").trim(),
    camposExtra: lista(process.env.AZDO_CAMPOS_EXTRA),
    camposCaso: camposFijos(process.env.AZDO_CAMPOS_CASO),
    // Destino de la migración de casos automatizados (una PBI por caso en el board del equipo).
    migracion: {
      proyecto: (process.env.AZDO_MIGRACION_PROYECTO || "aseguramiento-calidad").trim(),
      area: (process.env.AZDO_MIGRACION_AREA || "aseguramiento-calidad\\Gestion de Pruebas Automatizadas").trim(),
      iteracion: (process.env.AZDO_MIGRACION_ITERACION || "").trim(),
      tipo: (process.env.AZDO_MIGRACION_TIPO || "Pruebas Automatizadas").trim(),
      // Campo que ordena el tablero (Scrum: BacklogPriority; Agile: StackRank). Menor valor = más arriba.
      campoOrden: (process.env.AZDO_MIGRACION_CAMPO_ORDEN || "Microsoft.VSTS.Common.BacklogPriority").trim(),
    },
  };
}

/** AZDO_CAMPOS_CASO: campos fijos para cada Test Case, en JSON. Ej: {"Custom.Ambiente":"QA"} */
function camposFijos(valor) {
  if (!String(valor ?? "").trim()) return {};
  try {
    const campos = JSON.parse(valor);
    if (campos && typeof campos === "object" && !Array.isArray(campos)) return campos;
  } catch { /* se informa abajo */ }
  console.warn('Aviso: AZDO_CAMPOS_CASO no es un JSON válido (ejemplo: {"Custom.Ambiente":"QA"}); se ignora.');
  return {};
}

export class ErrorAzure extends Error {}

export function azureConfigurado() {
  const c = config();
  return Boolean(c.url && c.proyecto && c.pat);
}

export function infoAzure() {
  const c = config();
  return {
    configurado: azureConfigurado(),
    url: c.url,
    proyecto: c.proyecto,
    tagAutomatizado: c.tagAutomatizado,
    tagsCasos: c.tagsCasos,
    planConfigurado: Boolean(c.planId && c.suiteId),
    planId: c.planId,
    suiteId: c.suiteId,
    migracion: { proyecto: c.migracion.proyecto, area: c.migracion.area, tipo: c.migracion.tipo },
  };
}

// ---------------------------------------------------------------- HTTP

// El PAT solo se envía al servidor configurado (y a su dominio alterno *.visualstudio.com / dev.azure.com).
function origenesConfiables(c) {
  const base = new URL(c.url);
  const origenes = new Set([base.origin]);
  const org = base.hostname === "dev.azure.com" ? base.pathname.split("/").filter(Boolean)[0] : null;
  if (org) origenes.add(`https://${org}.visualstudio.com`);
  const vs = base.hostname.match(/^([^.]+)\.visualstudio\.com$/);
  if (vs) origenes.add("https://dev.azure.com");
  return origenes;
}

async function solicitar(ruta, { method = "GET", body, contentType = "application/json", binario = false } = {}) {
  const c = config();
  if (!azureConfigurado()) {
    throw new ErrorAzure("Azure DevOps no está configurado. Complete AZDO_ORG_URL, AZDO_PROJECT y AZDO_PAT en el archivo .env.");
  }
  const url = new URL(/^https?:\/\//i.test(ruta) ? ruta : `${c.url}/${encodeURIComponent(c.proyecto)}/_apis/${ruta}`);
  if (!origenesConfiables(c).has(url.origin)) {
    throw new ErrorAzure(`Se omitió una solicitud a un servidor no configurado (${url.origin}).`);
  }
  if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", c.apiVersion);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`:${c.pat}`).toString("base64")}`,
        Accept: binario ? "*/*" : "application/json",
        ...(body !== undefined ? { "Content-Type": contentType } : {}),
      },
      body: body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
  } catch (err) {
    const causa = err?.cause?.code ?? "";
    if (/CERT|SIGNATURE|SELF_SIGNED/.test(causa)) {
      throw new ErrorAzure("No se pudo verificar el certificado HTTPS de Azure DevOps. Inicie la app con npm.cmd start (incluye --use-system-ca).");
    }
    throw new ErrorAzure(`No fue posible conectarse con Azure DevOps (${c.url}). Revise la URL y la red/VPN de la empresa.`);
  }

  const tipo = res.headers.get("content-type") || "";
  // Con un PAT inválido Azure DevOps responde 203 o redirige a una página HTML de inicio de sesión.
  if (res.status === 401 || res.status === 203 || (!binario && tipo.includes("text/html"))) {
    throw new ErrorAzure("Azure DevOps rechazó el PAT: verifique que el token (o AZDO_PAT del .env) sea válido y no haya expirado.");
  }
  if (res.status === 403) {
    throw new ErrorAzure("El PAT no tiene permisos suficientes. Requiere: Work Items (lectura y escritura) y Test Management (lectura y escritura).");
  }
  if (!res.ok) {
    let detalle = "";
    try {
      detalle = (await res.json()).message ?? "";
    } catch { /* respuesta sin JSON */ }
    const error = new ErrorAzure(detalle || `Azure DevOps respondió con el código ${res.status}.`);
    error.status = res.status;
    throw error;
  }
  if (binario) return { buffer: Buffer.from(await res.arrayBuffer()), tipo };
  return res.status === 204 ? null : res.json();
}

/**
 * Verifica que un PAT de usuario tenga acceso al proyecto configurado.
 * Devuelve false si Azure lo rechaza; lanza ErrorAzure si no hay conexión con Azure.
 */
export async function validarPAT(pat) {
  const c = config();
  try {
    await conPAT(pat, () => solicitar(`${c.url}/_apis/projects/${encodeURIComponent(c.proyecto)}`));
    return true;
  } catch (err) {
    if (err instanceof ErrorAzure && (/rechazó el PAT|permisos/.test(err.message) || err.status === 404)) return false;
    throw err;
  }
}

export async function probarConexion() {
  const c = config();
  try {
    const proyecto = await solicitar(`${c.url}/_apis/projects/${encodeURIComponent(c.proyecto)}`);
    return { proyecto: proyecto.name, url: c.url };
  } catch (err) {
    if (err.status === 404) {
      throw new ErrorAzure(`El proyecto "${c.proyecto}" no existe en ${c.url} o el PAT no tiene acceso a él. Revise AZDO_PROJECT.`);
    }
    throw err;
  }
}

/**
 * Configuración vigente para la ventana "Configuración de Azure DevOps": a quién pertenece el token en uso
 * (nunca se devuelve el token, solo sus últimos 4 caracteres) y de dónde sale (navegador o .env).
 */
export async function datosConfiguracion() {
  const c = config();
  const datos = {
    url: c.url,
    proyecto: c.proyecto,
    origenToken: patDeSolicitud.getStore() ? "navegador" : "env",
    tokenFinal: c.pat ? c.pat.slice(-4) : "",
    tipoCaso: c.tipoCaso,
    tagAutomatizado: c.tagAutomatizado,
    tagsCasos: c.tagsCasos,
    planId: c.planId,
    suiteId: c.suiteId,
    migracion: { proyecto: c.migracion.proyecto, area: c.migracion.area },
    usuario: null,
    error: "",
  };
  if (!azureConfigurado()) return { ...datos, error: "Falta la organización, el proyecto o el token." };
  try {
    const cd = await solicitar(`${c.url}/_apis/connectionData?api-version=7.1-preview`);
    const u = cd?.authenticatedUser ?? {};
    datos.usuario = { nombre: u.providerDisplayName || u.customDisplayName || "", correo: u.properties?.Account?.$value || "" };
  } catch (err) {
    datos.error = err.message;
  }
  return datos;
}

/** Diagnóstico (solo lectura): el tipo de work item de casos de prueba existe en el proyecto. */
export async function verificarTipoCaso() {
  const c = config();
  try {
    const tipo = await solicitar(`wit/workitemtypes/${encodeURIComponent(c.tipoCaso)}`);
    return { nombre: tipo.name ?? c.tipoCaso };
  } catch (err) {
    if (err.status === 404) {
      throw new ErrorAzure(`El tipo de work item "${c.tipoCaso}" no existe en el proyecto. Revise AZDO_TIPO_CASO_PRUEBA.`);
    }
    throw err;
  }
}

/** Diagnóstico (solo lectura): el plan de pruebas configurado existe. */
export async function verificarPlan() {
  const c = config();
  if (!c.planId) return null;
  try {
    const plan = await solicitar(`testplan/plans/${encodeURIComponent(c.planId)}`);
    return { id: c.planId, nombre: plan.name ?? "", suiteId: c.suiteId };
  } catch (err) {
    if (err.status === 404) throw new ErrorAzure(`El plan de pruebas ${c.planId} no existe. Revise AZDO_TEST_PLAN_ID.`);
    throw err;
  }
}

// ---------------------------------------------------------------- Lectura de la HU

const TIPOS_IMAGEN = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_IMAGENES = 12;
const MAX_BYTES_IMAGEN = 4.5 * 1024 * 1024;
const MAX_DOCX = 3;

function tipoPorFirma(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const extension = (nombre) => (String(nombre).match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

function decodificarEntidades(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function imagenesEnHtml(html) {
  const imagenes = [];
  for (const m of String(html ?? "").matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const src = decodificarEntidades(m[1]);
    if (src.startsWith("data:")) continue;
    let nombre = "imagen";
    try {
      nombre = new URL(src).searchParams.get("fileName") || nombre;
    } catch { /* URL relativa */ }
    imagenes.push({ url: src, nombre });
  }
  return imagenes;
}

const nombrePersona = (v) => (v && typeof v === "object" ? v.displayName : v) || "";

/** Obtiene una HU (o cualquier work item) con sus campos, imágenes y adjuntos. */
export async function obtenerHU(id) {
  const c = config();
  let wi;
  const consultaAmpliada = true;
  try {
    wi = await solicitar(`wit/workitems/${encodeURIComponent(id)}?$expand=all`);
  } catch (err) {
    if (err.status === 404) throw new ErrorAzure(`No existe el work item #${id} en el proyecto ${c.proyecto} (o el PAT no tiene acceso).`);
    // Algunas organizaciones permiten leer los campos básicos, pero restringen
    // la expansión de relaciones/adjuntos. En ese caso la HU sigue siendo útil
    // para generar casos, aunque no se descarguen imágenes ni documentos.
    throw err;
  }
  const f = wi.fields ?? {};
  const advertencias = consultaAmpliada
    ? []
    : [`Azure DevOps devolvió la información básica de la HU #${id}; no fue posible cargar relaciones ni adjuntos.`];

  const camposHtml = [
    ["Descripción", f["System.Description"]],
    ["Criterios de aceptación", f["Microsoft.VSTS.Common.AcceptanceCriteria"]],
    ["Pasos para reproducir", f["Microsoft.VSTS.TCM.ReproSteps"]],
    ...c.camposExtra.map((campo) => [campo, f[campo]]),
  ].filter(([, v]) => v !== undefined && v !== null && String(v).trim());

  // Imágenes: incrustadas en los campos HTML + adjuntos de tipo imagen.
  const candidatas = camposHtml.flatMap(([, html]) => imagenesEnHtml(html).map((i) => ({ ...i, origen: "Descripción" })));
  const relaciones = wi.relations ?? [];
  const adjuntos = relaciones
    .filter((r) => r.rel === "AttachedFile")
    .map((r) => ({ url: r.url, nombre: r.attributes?.name ?? "adjunto", tamano: r.attributes?.resourceSize ?? null }));
  for (const a of adjuntos) if (TIPOS_IMAGEN[extension(a.nombre)]) candidatas.push({ url: a.url, nombre: a.nombre, origen: "Adjunto" });

  const vistas = new Set();
  const imagenes = [];
  for (const img of candidatas) {
    const clave = img.url.split("?")[0].toLowerCase();
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    if (imagenes.length >= MAX_IMAGENES) {
      advertencias.push(`Se omitieron imágenes adicionales: el máximo es ${MAX_IMAGENES}.`);
      break;
    }
    try {
      const { buffer } = await solicitar(img.url, { binario: true });
      const mediaType = tipoPorFirma(buffer);
      if (!mediaType) {
        advertencias.push(`"${img.nombre}" no es PNG, JPG, GIF ni WEBP y no se puede enviar a la IA.`);
        continue;
      }
      if (buffer.length > MAX_BYTES_IMAGEN) {
        advertencias.push(`"${img.nombre}" pesa más de 4.5 MB y se omitió.`);
        continue;
      }
      imagenes.push({ nombre: img.nombre, origen: img.origen, mediaType, base64: buffer.toString("base64") });
    } catch (err) {
      advertencias.push(`No se pudo descargar la imagen "${img.nombre}": ${err.message}`);
    }
  }

  // Documentos Word adjuntos: se extrae su texto como contexto adicional.
  const documentos = [];
  for (const a of adjuntos.filter((x) => extension(x.nombre) === "docx").slice(0, MAX_DOCX)) {
    try {
      const { buffer } = await solicitar(a.url, { binario: true });
      const texto = await extraerTextoDocx(buffer);
      if (texto) documentos.push({ nombre: a.nombre, texto });
    } catch (err) {
      advertencias.push(`No se pudo leer el documento adjunto "${a.nombre}": ${err.message}`);
    }
  }

  const tipo = f["System.WorkItemType"] ?? "Work item";
  const titulo = f["System.Title"] ?? "";
  const secciones = camposHtml.map(([nombre, html]) => ({ nombre, texto: htmlATexto(html) })).filter((s) => s.texto);
  const casosVinculados = relaciones.filter((r) => r.rel === "Microsoft.VSTS.Common.TestedBy-Forward").length;

  const textoRequerimiento = [
    `${tipo} #${wi.id}: ${titulo}`,
    ...secciones.map((s) => `${s.nombre}:\n${s.texto}`),
    ...documentos.map((d) => `Documento adjunto "${d.nombre}":\n${d.texto}`),
  ].join("\n\n");

  return {
    id: wi.id,
    url: wi.url,
    enlace: wi._links?.html?.href ?? `${c.url}/${encodeURIComponent(c.proyecto)}/_workitems/edit/${wi.id}`,
    tipo,
    titulo,
    estado: f["System.State"] ?? "",
    asignado: nombrePersona(f["System.AssignedTo"]),
    area: f["System.AreaPath"] ?? "",
    iteracion: f["System.IterationPath"] ?? "",
    tags: lista(f["System.Tags"]),
    automatizado: lista(f["System.Tags"]).some((t) => t.toLowerCase() === c.tagAutomatizado.toLowerCase()),
    secciones,
    imagenes,
    adjuntos: adjuntos.map(({ nombre, tamano }) => ({ nombre, tamano })),
    documentos: documentos.map((d) => ({ nombre: d.nombre, caracteres: d.texto.length })),
    casosVinculados,
    textoRequerimiento,
    advertencias: [...new Set(advertencias)],
  };
}

// ---------------------------------------------------------------- Creación de casos de prueba

const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const escXml = escHtml;

/** Campo Microsoft.VSTS.TCM.Steps: XML cuyo contenido de cada paso es HTML escapado. */
export function construirPasosXml(pasos) {
  const parrafo = (texto) => escXml(`<DIV><P>${escHtml(texto).replace(/\r?\n/g, "<BR/>")}</P></DIV>`);
  let idPaso = 1;
  const xmlPasos = (pasos ?? []).map((p) => {
    idPaso += 1;
    const esperado = String(p.resultado_esperado ?? "").trim();
    return (
      `<step id="${idPaso}" type="${esperado ? "ValidateStep" : "ActionStep"}">` +
      `<parameterizedString isformatted="true">${parrafo(p.accion)}</parameterizedString>` +
      `<parameterizedString isformatted="true">${esperado ? parrafo(esperado) : ""}</parameterizedString>` +
      `<description/></step>`
    );
  });
  return `<steps id="0" last="${idPaso}">${xmlPasos.join("")}</steps>`;
}

function construirDescripcion(caso) {
  const partes = [];
  // Primero, la descripción de lo que prueba el caso (lo que el equipo lee al abrir el Test Case).
  if (caso.descripcion) partes.push(`<p><b>Descripción</b></p><p>${escHtml(caso.descripcion)}</p>`);
  const criterios = (caso.criterios_relacionados ?? []).join(", ");
  if (criterios) partes.push(`<table><tr><td><b>Criterios de aceptación</b></td><td>${escHtml(criterios)}</td></tr></table>`);
  if (caso.precondiciones?.length) {
    partes.push(`<p><b>Precondiciones</b></p><ul>${caso.precondiciones.map((p) => `<li>${escHtml(p)}</li>`).join("")}</ul>`);
  }
  if (caso.datos_prueba?.length) {
    partes.push(
      `<p><b>Datos de prueba</b></p><ul>${caso.datos_prueba.map((d) => `<li><b>${escHtml(d.campo)}:</b> ${escHtml(d.valor)}</li>`).join("")}</ul>`,
    );
  }
  if (caso.resultado_esperado_final) {
    partes.push(`<p><b>Resultado esperado final</b></p><p>${escHtml(caso.resultado_esperado_final)}</p>`);
  }
  return partes.join("");
}

const PRIORIDAD_AZURE = { Alta: 1, Media: 2, Baja: 3 };

/** Obtiene los datos de la HU necesarios para vincular casos (url, área, iteración). */
export async function obtenerReferenciaHU(id) {
  try {
    const wi = await solicitar(`wit/workitems/${encodeURIComponent(id)}`);
    return {
      id: wi.id,
      url: wi.url,
      titulo: wi.fields["System.Title"],
      tipo: wi.fields["System.WorkItemType"],
      area: wi.fields["System.AreaPath"],
      iteracion: wi.fields["System.IterationPath"],
      proyecto: wi.fields["System.TeamProject"],
      proyectoAsociado: wi.fields[CAMPO_PROYECTO_ASOCIADO] ?? "",
    };
  } catch (err) {
    if (err.status === 404) throw new ErrorAzure(`No existe la HU #${id} en el proyecto ${config().proyecto}.`);
    throw err;
  }
}

/** Crea un Test Case vinculado a la HU con la relación "Tested By". */
export async function crearCasoPrueba(caso, hu, tagsExtra = []) {
  const c = config();
  const tags = [...new Set([...c.tagsCasos, ...tagsExtra, caso.tipo].filter(Boolean))];
  const operaciones = [
    { op: "add", path: "/fields/System.Title", value: String(caso.titulo).slice(0, 255) },
    { op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: construirPasosXml(caso.pasos) },
    { op: "add", path: "/fields/System.Description", value: construirDescripcion(caso) },
  ];
  if (PRIORIDAD_AZURE[caso.prioridad]) {
    operaciones.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: PRIORIDAD_AZURE[caso.prioridad] });
  }
  if (tags.length) operaciones.push({ op: "add", path: "/fields/System.Tags", value: tags.join("; ") });
  for (const [campo, valor] of Object.entries(c.camposCaso)) {
    operaciones.push({ op: "add", path: `/fields/${campo}`, value: valor });
  }
  if (hu) {
    if (hu.area) operaciones.push({ op: "add", path: "/fields/System.AreaPath", value: hu.area });
    if (hu.iteracion) operaciones.push({ op: "add", path: "/fields/System.IterationPath", value: hu.iteracion });
    operaciones.push({
      op: "add",
      path: "/relations/-",
      value: { rel: "Microsoft.VSTS.Common.TestedBy-Reverse", url: hu.url, attributes: { comment: "Generado con Ecosistema de Aseguramiento de Calidad TI" } },
    });
  }

  const wi = await solicitar(`wit/workitems/$${encodeURIComponent(c.tipoCaso)}`, {
    method: "POST",
    body: operaciones,
    contentType: "application/json-patch+json",
  });
  return {
    id: wi.id,
    enlace: wi._links?.html?.href ?? `${c.url}/${encodeURIComponent(c.proyecto)}/_workitems/edit/${wi.id}`,
    proyecto: wi.fields?.["System.TeamProject"] ?? c.proyecto,
  };
}

// ---------------------------------------------------------------- Estado inicial del Test Case
// En el proceso del equipo un Test Case nace en "Design" (no se puede crear en otro estado) y para pasarlo a
// UNEXECUTED el proceso exige Start Date y Proyecto Asociado. AZDO_ESTADO_INICIAL_CASO permite cambiarlo.
const CAMPO_INICIO = "Microsoft.VSTS.Scheduling.StartDate";
const CAMPO_PROYECTO_ASOCIADO = "Custom.ProyectoAsociado";
const ESTADO_INICIAL_CASO = (process.env.AZDO_ESTADO_INICIAL_CASO || "UNEXECUTED").trim();
const tipoCasoPorProyecto = new Map();

/** Estados y campos del Test Case en ese proyecto (cada proyecto puede tener su propio proceso). */
async function tipoCaso(proyecto) {
  if (!tipoCasoPorProyecto.has(proyecto)) {
    const c = config();
    const base = `${c.url}/${encodeURIComponent(proyecto)}/_apis/wit/workitemtypes/${encodeURIComponent(c.tipoCaso)}`;
    // Se guarda la promesa: si se publican varios casos en paralelo, todos esperan la misma consulta.
    const consulta = (async () => {
      const [estados, campos] = await Promise.all([solicitar(`${base}/states`), solicitar(`${base}/fields`)]);
      return {
        estados: (estados.value ?? []).map((s) => s.name),
        // Estado de categoría "Removed" del proceso (ej. "Dismissed"): para casos reemplazados o duplicados.
        estadoDescartado: (estados.value ?? []).find((s) => s.category === "Removed")?.name ?? null,
        campos: new Set((campos.value ?? []).map((x) => x.referenceName)),
      };
    })();
    tipoCasoPorProyecto.set(proyecto, consulta);
    consulta.catch(() => tipoCasoPorProyecto.delete(proyecto));
  }
  return tipoCasoPorProyecto.get(proyecto);
}

/** Valores permitidos de "Proyecto Asociado" en ese proyecto ([] si el proceso no tiene el campo). */
export async function valoresProyectoAsociado(proyecto) {
  const c = config();
  if (!(await tipoCaso(proyecto)).campos.has(CAMPO_PROYECTO_ASOCIADO)) return [];
  const r = await solicitar(`${c.url}/${encodeURIComponent(proyecto)}/_apis/wit/workitemtypes/${encodeURIComponent(c.tipoCaso)}/fields/${CAMPO_PROYECTO_ASOCIADO}?$expand=allowedValues`);
  return r.allowedValues ?? [];
}

/** Pasa un Test Case recién creado al estado inicial del equipo (UNEXECUTED). Devuelve el estado o null si el proceso no lo tiene. */
export async function pasarAEstadoInicial(id, proyecto, proyectoAsociado) {
  const c = config();
  const tipo = await tipoCaso(proyecto);
  const estado = tipo.estados.find((s) => s.toLowerCase() === ESTADO_INICIAL_CASO.toLowerCase());
  if (!estado) return null;
  const ops = [{ op: "add", path: "/fields/System.State", value: estado }];
  if (tipo.campos.has(CAMPO_INICIO)) ops.push({ op: "add", path: `/fields/${CAMPO_INICIO}`, value: new Date().toISOString() });
  if (tipo.campos.has(CAMPO_PROYECTO_ASOCIADO) && proyectoAsociado) ops.push({ op: "add", path: `/fields/${CAMPO_PROYECTO_ASOCIADO}`, value: proyectoAsociado });
  try {
    await solicitar(`${c.url}/${encodeURIComponent(proyecto)}/_apis/wit/workitems/${encodeURIComponent(id)}`, { method: "PATCH", contentType: "application/json-patch+json", body: ops });
  } catch (err) {
    if (/Proyecto Asociado/i.test(err.message) && !proyectoAsociado) throw new ErrorAzure(`Quedó en "Design": seleccione el Proyecto asociado para pasarlo a ${estado}.`);
    throw err;
  }
  return estado;
}

/** Agrega casos al plan/suite configurado (AZDO_TEST_PLAN_ID / AZDO_TEST_SUITE_ID). */
export async function agregarASuite(ids) {
  const c = config();
  if (!c.planId || !c.suiteId || !ids.length) return null;
  await solicitar(`testplan/Plans/${encodeURIComponent(c.planId)}/Suites/${encodeURIComponent(c.suiteId)}/TestCase`, {
    method: "POST",
    body: ids.map((id) => ({ workItem: { id } })),
  });
  return { planId: c.planId, suiteId: c.suiteId };
}

// ---------------------------------------------------------------- Lectura de casos existentes

const desXml = (s) =>
  String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Convierte el XML de Microsoft.VSTS.TCM.Steps en una lista de pasos con texto plano. */
export function leerPasosXml(xml) {
  const pasos = [];
  const texto = String(xml ?? "");
  for (const m of texto.matchAll(/<step\b[^>]*>([\s\S]*?)<\/step>|<compref\b[^>]*\bref="(\d+)"[^>]*\/?>/g)) {
    if (m[2]) {
      pasos.push({ numero: 0, accion: `Ejecutar los pasos compartidos (Shared Steps) #${m[2]}`, resultado_esperado: "" });
      continue;
    }
    const cadenas = [...m[1].matchAll(/<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>|<parameterizedString[^>]*\/>/g)].map((p) =>
      htmlATexto(desXml(p[1] ?? "")).replace(/\s*\n\s*/g, " ").trim(),
    );
    if (cadenas[0] || cadenas[1]) pasos.push({ numero: 0, accion: cadenas[0] ?? "", resultado_esperado: cadenas[1] ?? "" });
  }
  pasos.forEach((p, i) => (p.numero = i + 1));
  return pasos;
}

const PRIORIDAD_DESDE_AZURE = { 1: "Alta", 2: "Media", 3: "Baja", 4: "Baja" };

/** Obtiene los Test Cases vinculados a una HU (relación "Tested By"), listos para automatizar. */
export async function obtenerCasosDeHU(huId) {
  const c = config();
  let wi;
  try {
    wi = await solicitar(`wit/workitems/${encodeURIComponent(huId)}?$expand=relations`);
  } catch (err) {
    if (err.status === 404) throw new ErrorAzure(`No existe el work item #${huId} en el proyecto ${c.proyecto} (o el PAT no tiene acceso).`);
    throw err;
  }
  const hu = {
    id: wi.id,
    titulo: wi.fields?.["System.Title"] ?? "",
    tipo: wi.fields?.["System.WorkItemType"] ?? "",
    estado: wi.fields?.["System.State"] ?? "",
    enlace: wi._links?.html?.href ?? `${c.url}/${encodeURIComponent(c.proyecto)}/_workitems/edit/${wi.id}`,
    tags: lista(wi.fields?.["System.Tags"]),
    iteracion: wi.fields?.["System.IterationPath"] ?? "",
    area: wi.fields?.["System.AreaPath"] ?? "",
    proyecto: wi.fields?.["System.TeamProject"] ?? "",
  };
  hu.automatizado = hu.tags.some((t) => t.toLowerCase() === c.tagAutomatizado.toLowerCase());
  const ids = [
    ...new Set(
      (wi.relations ?? [])
        .filter((r) => r.rel === "Microsoft.VSTS.Common.TestedBy-Forward")
        .map((r) => Number(String(r.url).split("/").pop()))
        .filter((n) => n > 0),
    ),
  ];
  if (!ids.length) return { hu, casos: [] };

  const campos = [
    "System.Id",
    "System.Title",
    "System.State",
    "System.Tags",
    "System.WorkItemType",
    "System.Description",
    "Microsoft.VSTS.TCM.Steps",
    "Microsoft.VSTS.Common.Priority",
  ].join(",");
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200).join(",");
    const r = await solicitar(`wit/workitems?ids=${lote}&fields=${campos}&errorPolicy=omit`);
    items.push(...(r.value ?? []).filter(Boolean));
  }

  const casos = items
    .filter((it) => (it.fields?.["System.WorkItemType"] ?? c.tipoCaso) === c.tipoCaso)
    .map((it) => {
      const f = it.fields ?? {};
      const descripcion = htmlATexto(f["System.Description"] ?? "");
      // Si el caso se publicó desde esta aplicación, la descripción trae su ID de diseño (ej. CP-001).
      const idDiseno = descripcion.match(/ID de diseño\s*\|?\s*([A-Za-z0-9_-]+)/)?.[1];
      const tags = lista(f["System.Tags"]);
      return {
        id: idDiseno || `TC-${it.id}`,
        azure_id: it.id,
        hu_id: hu.id,
        titulo: f["System.Title"] ?? "",
        estado_azure: f["System.State"] ?? "",
        tipo: "Funcional",
        enfoque: "Positivo",
        prioridad: PRIORIDAD_DESDE_AZURE[f["Microsoft.VSTS.Common.Priority"]] ?? "Media",
        tecnica: "No especificada",
        criterios_relacionados: [],
        precondiciones: descripcion ? [descripcion.slice(0, 2000)] : [],
        datos_prueba: [],
        pasos: leerPasosXml(f["Microsoft.VSTS.TCM.Steps"]),
        resultado_esperado_final: "",
        tags,
        automatizado: tags.some((t) => t.toLowerCase() === c.tagAutomatizado.toLowerCase()),
        azure_enlace: `${c.url}/${encodeURIComponent(c.proyecto)}/_workitems/edit/${it.id}`,
      };
    })
    .map((caso) => ({ ...caso, resultado_esperado_final: caso.pasos.at(-1)?.resultado_esperado ?? "" }));

  return { hu, casos, omitidos: ids.length - items.length };
}

// ---------------------------------------------------------------- Migración a "Gestión de Pruebas Automatizadas"

const REL_PROBADO_POR = "Microsoft.VSTS.Common.TestedBy-Forward"; // PBI/HU -> Test Case
const REL_PRUEBA = "Microsoft.VSTS.Common.TestedBy-Reverse"; // Test Case -> PBI/HU que prueba
const idDeUrl = (url) => Number(String(url).split("/").pop());

// ---------------------------------------------------------------- Desvincular / reemplazar casos de una HU

/** Estado "Removed" del Test Case en el proyecto (ej. "Dismissed"), o null si el proceso no lo tiene. */
export async function estadoDescartadoCaso(proyecto = config().proyecto) {
  return (await tipoCaso(proyecto)).estadoDescartado;
}

/**
 * Quita la relación "Tested By" entre la HU y los casos indicados (no borra los casos). Con `descartar`, además
 * pasa cada caso desvinculado al estado "Removed" del proceso (Dismissed) para que no se ejecute ni se cuente.
 * Deja constancia en el historial de la HU y de cada caso.
 */
export async function desvincularCasosDeHU(huId, ids, { descartar = false, motivo = "" } = {}) {
  const c = config();
  const objetivo = new Set(ids.map(Number).filter((n) => n > 0));
  let hu;
  try {
    hu = await solicitar(`wit/workitems/${encodeURIComponent(huId)}?$expand=relations`);
  } catch (err) {
    if (err.status === 404) throw new ErrorAzure(`No existe la HU #${huId} en el proyecto ${c.proyecto}.`);
    throw err;
  }
  const relaciones = (hu.relations ?? []).map((r, i) => ({ i, id: idDeUrl(r.url), rel: r.rel }));
  const quitar = relaciones.filter((r) => r.rel === REL_PROBADO_POR && objetivo.has(r.id));
  const desvinculados = [...new Set(quitar.map((r) => r.id))];
  const noVinculados = [...objetivo].filter((id) => !desvinculados.includes(id));
  const nota = motivo ? ` Motivo: ${motivo}.` : "";

  if (quitar.length) {
    // Se quitan de mayor a menor índice para que los índices restantes sigan siendo válidos; "test /rev" evita
    // pisar un cambio hecho en la HU mientras tanto.
    const ops = [
      { op: "test", path: "/rev", value: hu.rev },
      ...quitar.sort((a, b) => b.i - a.i).map((r) => ({ op: "remove", path: `/relations/${r.i}` })),
      { op: "add", path: "/fields/System.History", value: `Casos de prueba desvinculados desde el Ecosistema de Aseguramiento de Calidad TI: ${desvinculados.map((id) => `#${id}`).join(", ")}.${nota}` },
    ];
    await solicitar(`${c.url}/_apis/wit/workitems/${encodeURIComponent(huId)}`, { method: "PATCH", contentType: "application/json-patch+json", body: ops });
  }

  const descartados = [];
  const errores = [];
  if (descartar && desvinculados.length) {
    const proyecto = hu.fields?.["System.TeamProject"] || c.proyecto;
    const estado = await estadoDescartadoCaso(proyecto);
    if (!estado) errores.push({ id: null, error: "El proceso del Test Case no tiene un estado de descarte (categoría Removed)." });
    else {
      for (const id of desvinculados) {
        try {
          await solicitar(`${c.url}/_apis/wit/workitems/${encodeURIComponent(id)}`, {
            method: "PATCH",
            contentType: "application/json-patch+json",
            body: [
              { op: "add", path: "/fields/System.State", value: estado },
              { op: "add", path: "/fields/System.History", value: `Pasado a ${estado} al desvincularlo de la HU #${huId} desde el Ecosistema de Aseguramiento de Calidad TI.${nota}` },
            ],
          });
          descartados.push(id);
        } catch (err) {
          errores.push({ id, error: err.message });
        }
      }
    }
  }
  return { hu: { id: hu.id, titulo: hu.fields?.["System.Title"] ?? "" }, desvinculados, noVinculados, descartados, errores };
}
const enlaceWI = (c, proyecto, id) => `${c.url}/${encodeURIComponent(proyecto)}/_workitems/edit/${id}`;

/** Trae work items de cualquier proyecto de la organización, en lotes de 200. */
async function workItemsOrg(ids, { relaciones = false, campos = null } = {}) {
  const c = config();
  const salida = [];
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    // errorPolicy "Omit": un elemento sin permiso de lectura no hace fallar todo el lote.
    const cuerpo = relaciones ? { ids: lote, $expand: "Relations", errorPolicy: "Omit" } : { ids: lote, fields: campos, errorPolicy: "Omit" };
    const r = await solicitar(`${c.url}/_apis/wit/workitemsbatch`, { method: "POST", body: cuerpo });
    salida.push(...(r?.value ?? []).filter(Boolean));
  }
  return salida;
}

const bajoArea = (area, raiz) => {
  const a = String(area ?? "").toLowerCase();
  const r = raiz.toLowerCase();
  return a === r || a.startsWith(`${r}\\`);
};

/** Clasifica lo que un Test Case "prueba": la PBI de migración (destino) y las HU de origen. */
function clasificarVinculos(c, relacionados) {
  const m = c.migracion;
  const pbi = relacionados.find(
    (w) =>
      w.fields["System.TeamProject"] === m.proyecto &&
      w.fields["System.WorkItemType"] === m.tipo &&
      bajoArea(w.fields["System.AreaPath"], m.area),
  );
  const hu = relacionados.filter((w) => w !== pbi);
  const resumen = (w) => ({
    id: w.id,
    titulo: w.fields["System.Title"] ?? "",
    tipo: w.fields["System.WorkItemType"] ?? "",
    proyecto: w.fields["System.TeamProject"] ?? "",
    enlace: enlaceWI(c, w.fields["System.TeamProject"], w.id),
  });
  return { pbi: pbi ? resumen(pbi) : null, hu: hu.map(resumen) };
}

/** PBI de la pizarra de pruebas automatizadas vinculada a un Test Case, o null si aún no se migró. */
export async function pbiDeCaso(id) {
  const c = config();
  const [caso] = await workItemsOrg([Number(id)], { relaciones: true });
  if (!caso) return null;
  const ids = (caso.relations ?? []).filter((r) => r.rel === REL_PRUEBA).map((r) => idDeUrl(r.url));
  if (!ids.length) return null;
  const vinculados = await workItemsOrg(ids, { campos: ["System.Title", "System.WorkItemType", "System.TeamProject", "System.AreaPath"] });
  return clasificarVinculos(c, vinculados).pbi;
}

/** Valor de orden para que un elemento nuevo quede PRIMERO en su columna del tablero de destino. */
export async function ordenAlInicio() {
  const c = config();
  const m = c.migracion;
  const w = await solicitar(`${c.url}/${encodeURIComponent(m.proyecto)}/_apis/wit/wiql?$top=1`, {
    method: "POST",
    body: {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = '${m.tipo.replace(/'/g, "''")}' AND [System.AreaPath] UNDER '${m.area.replace(/'/g, "''")}' AND [${m.campoOrden}] > 0 ORDER BY [${m.campoOrden}] ASC`,
    },
  });
  const id = w?.workItems?.[0]?.id;
  if (!id) return null;
  const [primero] = await workItemsOrg([id], { campos: [m.campoOrden] });
  const valor = Number(primero?.fields?.[m.campoOrden]);
  if (!(valor > 0)) return null;
  return valor > 2 ? valor - 1 : valor / 2;
}

// Campos que la app completa sola al crear el elemento de destino.
const CAMPOS_AUTOMATICOS = new Set(["System.Title", "System.State", "System.AreaId", "System.IterationId", "System.AreaPath", "System.IterationPath"]);
let cacheCamposMigracion = { clave: "", vence: 0, campos: [] };

/**
 * Campos obligatorios del tipo de destino que el usuario debe elegir (listas de valores, por ejemplo
 * "Proyecto Asociado"). Los de fecha obligatorios se completan con la fecha de la migración.
 */
export async function camposMigracion() {
  const c = config();
  const m = c.migracion;
  const clave = `${c.url}|${m.proyecto}|${m.tipo}`;
  if (cacheCamposMigracion.clave === clave && cacheCamposMigracion.vence > Date.now()) return cacheCamposMigracion.campos;
  const r = await solicitar(`${c.url}/${encodeURIComponent(m.proyecto)}/_apis/wit/workitemtypes/${encodeURIComponent(m.tipo)}/fields?$expand=all`);
  const campos = (r?.value ?? [])
    .filter((f) => f.alwaysRequired && !CAMPOS_AUTOMATICOS.has(f.referenceName))
    .map((f) => ({
      ref: f.referenceName,
      nombre: f.name,
      valores: f.allowedValues ?? [],
      porDefecto: f.defaultValue ?? null,
      fecha: /date/i.test(f.referenceName) && !(f.allowedValues ?? []).length,
    }));
  cacheCamposMigracion = { clave, vence: Date.now() + 10 * 60_000, campos };
  return campos;
}

/**
 * Test Cases con el tag de automatización en TODOS los proyectos de la organización (más los de `idsExtra`,
 * p. ej. los de una HU que aún no se automatizan), con su HU de origen y, si ya se migraron, la PBI que
 * los agrupa en el board de destino. `automatizado` indica si el caso ya tiene el tag.
 */
export async function listarCasosAutomatizados(idsExtra = []) {
  const c = config();
  const tag = c.tagAutomatizado.replace(/'/g, "''");
  const tipo = c.tipoCaso.replace(/'/g, "''");
  const wiql = await solicitar(`${c.url}/_apis/wit/wiql?$top=5000`, {
    method: "POST",
    body: { query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = '${tipo}' AND [System.Tags] CONTAINS '${tag}' ORDER BY [System.ChangedDate] DESC` },
  });
  const idsWiql = (wiql?.workItems ?? []).map((w) => w.id);
  const ids = [...new Set([...(Array.isArray(idsExtra) ? idsExtra : [idsExtra]).map(Number).filter(Boolean), ...idsWiql])];
  const casos = await workItemsOrg(ids, { relaciones: true });

  const idsRelacionados = [...new Set(casos.flatMap((w) => (w.relations ?? []).filter((r) => r.rel === REL_PRUEBA).map((r) => idDeUrl(r.url))))];
  const relacionados = new Map(
    (await workItemsOrg(idsRelacionados, { campos: ["System.Title", "System.WorkItemType", "System.TeamProject", "System.AreaPath"] })).map((w) => [w.id, w]),
  );

  return {
    destino: {
      ...c.migracion,
      enlace: `${c.url}/${encodeURIComponent(c.migracion.proyecto)}/_backlogs`,
      campos: (await camposMigracion()).filter((f) => !f.fecha),
    },
    tag: c.tagAutomatizado,
    casos: casos.map((w) => {
      const f = w.fields;
      const vinculos = (w.relations ?? []).filter((r) => r.rel === REL_PRUEBA).map((r) => relacionados.get(idDeUrl(r.url))).filter(Boolean);
      return {
        id: w.id,
        titulo: f["System.Title"] ?? "",
        proyecto: f["System.TeamProject"] ?? "",
        area: f["System.AreaPath"] ?? "",
        estado: f["System.State"] ?? "",
        automatizado: lista(f["System.Tags"]).some((t) => t.toLowerCase() === c.tagAutomatizado.toLowerCase()),
        cambiado: f["System.ChangedDate"] ?? null,
        enlace: enlaceWI(c, f["System.TeamProject"], w.id),
        ...clasificarVinculos(c, vinculos),
      };
    }),
  };
}

/**
 * Crea el elemento de destino ("Pruebas Automatizadas") de un Test Case y lo vincula al caso ("Tested By")
 * y a su HU de origen ("Related"). Si el caso ya lo tiene, no crea otro. El caso puede migrarse antes de
 * automatizarlo (no necesita el tag): al automatizarlo y marcarlo, las evidencias se adjuntan a esta PBI.
 * `valores`: campos obligatorios elegidos por el usuario (ej. { "Custom.ProyectoAsociado": "PBM_Farmacias" }).
 */
export async function migrarCasoAutomatizado(id, valores = {}) {
  const c = config();
  const m = c.migracion;
  const operacionesCampos = [];
  for (const campo of await camposMigracion()) {
    if (campo.fecha) {
      operacionesCampos.push({ op: "add", path: `/fields/${campo.ref}`, value: new Date().toISOString() });
      continue;
    }
    const valor = String(valores?.[campo.ref] ?? campo.porDefecto ?? "").trim();
    if (!valor) throw new ErrorAzure(`Seleccione "${campo.nombre}" antes de migrar.`);
    if (campo.valores.length && !campo.valores.includes(valor)) throw new ErrorAzure(`"${valor}" no es un valor válido para "${campo.nombre}".`);
    operacionesCampos.push({ op: "add", path: `/fields/${campo.ref}`, value: valor });
  }
  const [caso] = await workItemsOrg([Number(id)], { relaciones: true });
  if (!caso) throw new ErrorAzure(`No se encontró el caso de prueba #${id}.`);

  const idsVinculados = (caso.relations ?? []).filter((r) => r.rel === REL_PRUEBA).map((r) => idDeUrl(r.url));
  const vinculados = await workItemsOrg(idsVinculados, { campos: ["System.Title", "System.WorkItemType", "System.TeamProject", "System.AreaPath"] });
  const { pbi, hu } = clasificarVinculos(c, vinculados);
  if (pbi) return { id: Number(id), pbi, yaExistia: true };

  const f = caso.fields;
  const titulo = `${caso.id} - ${f["System.Title"] ?? ""}`.slice(0, 255);
  const descripcion = [
    `<p>Prueba automatizada migrada desde el <b>Ecosistema de Aseguramiento de Calidad TI</b>.</p>`,
    `<p><b>Caso de prueba:</b> <a href="${escHtml(enlaceWI(c, f["System.TeamProject"], caso.id))}">#${caso.id} ${escHtml(f["System.Title"] ?? "")}</a> (proyecto ${escHtml(f["System.TeamProject"] ?? "")})</p>`,
    ...hu.map((h) => `<p><b>${escHtml(h.tipo)} de origen:</b> <a href="${escHtml(h.enlace)}">#${h.id} ${escHtml(h.titulo)}</a> (proyecto ${escHtml(h.proyecto)})</p>`),
  ].join("");

  const operaciones = [
    { op: "add", path: "/fields/System.Title", value: titulo },
    { op: "add", path: "/fields/System.AreaPath", value: m.area },
    { op: "add", path: "/fields/System.Description", value: descripcion },
    // El tag de automatización es solo del Test Case; el elemento de destino no lo lleva.
    { op: "add", path: "/relations/-", value: { rel: REL_PROBADO_POR, url: `${c.url}/_apis/wit/workItems/${caso.id}`, attributes: { comment: "Caso de prueba automatizado" } } },
    ...hu.map((h) => ({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Related", url: `${c.url}/_apis/wit/workItems/${h.id}`, attributes: { comment: "Historia de Usuario de origen" } } })),
  ];
  operaciones.push(...operacionesCampos);
  if (m.iteracion) operaciones.push({ op: "add", path: "/fields/System.IterationPath", value: m.iteracion });
  // Primero en la columna "Nuevo" del tablero (si no se puede calcular, Azure lo deja al final).
  try {
    const orden = await ordenAlInicio();
    if (orden) operaciones.push({ op: "add", path: `/fields/${m.campoOrden}`, value: orden });
  } catch { /* el orden es opcional */ }

  const creado = await solicitar(`${c.url}/${encodeURIComponent(m.proyecto)}/_apis/wit/workitems/$${encodeURIComponent(m.tipo)}`, {
    method: "POST",
    body: operaciones,
    contentType: "application/json-patch+json",
  });
  return {
    id: Number(id),
    pbi: { id: creado.id, titulo, tipo: m.tipo, proyecto: m.proyecto, enlace: creado._links?.html?.href ?? enlaceWI(c, m.proyecto, creado.id) },
    yaExistia: false,
  };
}

/**
 * Sube un archivo al almacén de adjuntos de Azure DevOps y devuelve su URL. Por defecto en el proyecto
 * configurado; con `proyecto`, en ese proyecto (p. ej. el de la pizarra de pruebas automatizadas).
 */
async function subirAdjunto(nombre, contenido, proyecto = null) {
  const c = config();
  const base = proyecto ? `${c.url}/${encodeURIComponent(proyecto)}/_apis/` : "";
  const r = await solicitar(`${base}wit/attachments?fileName=${encodeURIComponent(nombre)}`, {
    method: "POST",
    body: contenido,
    contentType: "application/octet-stream",
  });
  return r.url;
}

/**
 * Adjunta evidencias de la automatización (capturas y videos) al elemento de la pizarra
 * "Gestión de Pruebas Automatizadas" (PBI creada por la migración), con una nota en el historial.
 * @param {{nombre:string, contenido:Buffer, comentario?:string}[]} adjuntos
 */
export async function adjuntarEvidenciasPizarra(idPbi, adjuntos, detalle = "") {
  if (!adjuntos.length) return { id: Number(idPbi), adjuntos: 0 };
  const c = config();
  const m = c.migracion;
  const operaciones = [];
  for (const a of adjuntos) {
    const url = await subirAdjunto(a.nombre, a.contenido, m.proyecto);
    operaciones.push({ op: "add", path: "/relations/-", value: { rel: "AttachedFile", url, attributes: { comment: a.comentario ?? "Evidencia de la automatización" } } });
  }
  if (detalle) operaciones.push({ op: "add", path: "/fields/System.History", value: escHtml(detalle) });
  await solicitar(`${c.url}/${encodeURIComponent(m.proyecto)}/_apis/wit/workitems/${encodeURIComponent(idPbi)}`, {
    method: "PATCH",
    body: operaciones,
    contentType: "application/json-patch+json",
  });
  return { id: Number(idPbi), adjuntos: adjuntos.length };
}

/**
 * Agrega el tag de automatización a un Test Case existente (sin borrar sus otros tags) y, si se
 * indican, adjunta archivos en el mismo cambio. Las evidencias de la automatización NO van al caso:
 * se adjuntan a la pizarra al migrar (ver adjuntarEvidenciasPizarra).
 * @param {{nombre:string, contenido:Buffer, comentario?:string}[]} adjuntos
 */
export async function marcarAutomatizado(id, detalle, adjuntos = []) {
  const c = config();
  const wi = await solicitar(`wit/workitems/${encodeURIComponent(id)}?fields=System.Tags,System.WorkItemType`);
  const tags = lista(wi.fields?.["System.Tags"]);
  const yaTenia = tags.some((t) => t.toLowerCase() === c.tagAutomatizado.toLowerCase());
  const operaciones = [];
  if (!yaTenia) operaciones.push({ op: "add", path: "/fields/System.Tags", value: [...tags, c.tagAutomatizado].join("; ") });
  for (const a of adjuntos) {
    const url = await subirAdjunto(a.nombre, a.contenido);
    operaciones.push({ op: "add", path: "/relations/-", value: { rel: "AttachedFile", url, attributes: { comment: a.comentario ?? "Evidencia de ejecución" } } });
  }
  if (detalle) operaciones.push({ op: "add", path: "/fields/System.History", value: escHtml(detalle) });
  if (operaciones.length) {
    await solicitar(`wit/workitems/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: operaciones,
      contentType: "application/json-patch+json",
    });
  }
  return { id: Number(id), yaTenia, tag: c.tagAutomatizado, adjuntos: adjuntos.length };
}

// ---------------------------------------------------------------- Sprints (estimación de ejecución)

/**
 * Ruta de la API en `proyecto` (otro proyecto de la organización, como el filtro "Proyecto" del dashboard);
 * sin proyecto, la del proyecto configurado (AZDO_PROJECT).
 */
function enProyecto(proyecto, ruta) {
  return proyecto ? `${config().url}/${encodeURIComponent(proyecto)}/_apis/${ruta}` : ruta;
}

/** Proyectos de Azure DevOps de la organización (System.TeamProject), ordenados; `actual` es el configurado. */
export async function listarProyectos() {
  const c = config();
  const r = await solicitar(`${c.url}/_apis/projects?$top=500`);
  const nombres = (r?.value ?? []).map((p) => p.name).sort((a, b) => a.localeCompare(b, "es"));
  return { proyectos: nombres, actual: c.proyecto };
}

/**
 * Sprints (iteraciones) del proyecto: primero los que tienen fechas, del más reciente al más antiguo (`actual` marca el
 * vigente hoy), luego los que no tienen fechas y al final "Todo el proyecto" (`todo`: la iteración raíz, que incluye todas).
 */
export async function listarSprints(proyecto = "") {
  const raiz = await solicitar(enProyecto(proyecto, "wit/classificationnodes/iterations?$depth=10"));
  const hoy = new Date().toISOString().slice(0, 10);
  const sprints = [];
  const recorrer = (nodo, ruta) => {
    const actualRuta = ruta ? `${ruta}\\${nodo.name}` : nodo.name;
    const inicio = nodo.attributes?.startDate?.slice(0, 10);
    const fin = nodo.attributes?.finishDate?.slice(0, 10);
    if (ruta) sprints.push({ ruta: actualRuta, nombre: nodo.name, inicio: inicio ?? "", fin: fin ?? "", actual: Boolean(inicio && fin && inicio <= hoy && hoy <= fin) });
    for (const hijo of nodo.children ?? []) recorrer(hijo, actualRuta);
  };
  recorrer(raiz, "");
  sprints.sort((a, b) => Boolean(b.inicio) - Boolean(a.inicio) || b.inicio.localeCompare(a.inicio) || a.ruta.localeCompare(b.ruta, "es"));
  return [...sprints, { ruta: raiz.name, nombre: `Todo el proyecto ${raiz.name}`, inicio: "", fin: "", actual: false, todo: true }];
}

/** Rutas de área del proyecto (cada proyecto o equipo suele tener la suya), ordenadas. */
export async function listarAreas(proyecto = "") {
  const raiz = await solicitar(enProyecto(proyecto, "wit/classificationnodes/areas?$depth=10"));
  const areas = [];
  const recorrer = (nodo, ruta) => {
    const actualRuta = ruta ? `${ruta}\\${nodo.name}` : nodo.name;
    areas.push(actualRuta);
    for (const hijo of nodo.children ?? []) recorrer(hijo, actualRuta);
  };
  recorrer(raiz, "");
  return areas.sort((a, b) => a.localeCompare(b, "es"));
}

/** De estos IDs de historias, las que tienen casos de prueba vinculados ("Tested By"), con su iteración. */
async function historiasConCasos(ids) {
  const salida = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await solicitar(`wit/workitems?ids=${ids.slice(i, i + 200).join(",")}&$expand=relations&errorPolicy=omit`);
    for (const w of r?.value ?? []) {
      if (w && (w.relations ?? []).some((rel) => rel.rel === "Microsoft.VSTS.Common.TestedBy-Forward")) {
        salida.push({ id: w.id, iteracion: w.fields?.["System.IterationPath"] ?? "" });
      }
    }
  }
  return salida;
}

/** Cuántas historias (User Story / PBI) con casos de prueba de una ruta de área hay en cada sprint: { "<ruta del sprint>": n }. */
export async function historiasPorSprintDeArea(area, proyecto = "") {
  const areaSegura = String(area ?? "").replace(/'/g, "''");
  if (!areaSegura) return {};
  const wiql = await solicitar(enProyecto(proyecto, "wit/wiql?$top=5000"), {
    method: "POST",
    body: {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project
        AND [System.WorkItemType] IN ('User Story', 'Product Backlog Item')
        AND [System.AreaPath] UNDER '${areaSegura}'
        AND [System.State] <> 'Removed'`,
    },
  });
  const conteo = {};
  for (const h of await historiasConCasos((wiql?.workItems ?? []).map((w) => w.id))) {
    if (h.iteracion) conteo[h.iteracion] = (conteo[h.iteracion] ?? 0) + 1;
  }
  return conteo;
}

/**
 * Historias (User Story / Product Backlog Item) de un sprint con sus casos de prueba vinculados ("Tested By"),
 * incluidos los pasos y la prioridad de cada caso. Con `area`, solo las de esa ruta de área (y sus subáreas).
 */
export async function historiasDelSprint(ruta, area = "", proyecto = "") {
  const rutaSegura = String(ruta ?? "").replace(/'/g, "''");
  const areaSegura = String(area ?? "").replace(/'/g, "''");
  if (!rutaSegura) throw new ErrorAzure("Seleccione un sprint.");
  const wiql = await solicitar(enProyecto(proyecto, "wit/wiql?$top=1000"), {
    method: "POST",
    body: {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project
        AND [System.WorkItemType] IN ('User Story', 'Product Backlog Item')
        AND [System.IterationPath] UNDER '${rutaSegura}'
        ${areaSegura ? `AND [System.AreaPath] UNDER '${areaSegura}'` : ""}
        AND [System.State] <> 'Removed'
        ORDER BY [System.Id]`,
    },
  });
  // Solo las historias con casos de prueba vinculados (las demás no suman al estimado).
  const ids = (await historiasConCasos((wiql?.workItems ?? []).map((w) => w.id))).map((h) => h.id);
  const historias = [];
  // De 4 en 4 para no saturar Azure DevOps. Por ID, los work items se leen sin importar su proyecto.
  for (let i = 0; i < ids.length; i += 4) {
    historias.push(...(await Promise.all(ids.slice(i, i + 4).map((id) => obtenerCasosDeHU(id)))));
  }
  return historias;
}

/**
 * HUs (User Story / PBI) de un sprint para DISEÑAR casos: todas las de la iteración, tengan o no casos
 * de prueba vinculados. `casos` es el número de Test Cases que ya tiene cada HU (para omitirlas por defecto).
 */
export async function historiasParaDisenar(ruta, area = "", proyecto = "") {
  const rutaSegura = String(ruta ?? "").replace(/'/g, "''");
  const areaSegura = String(area ?? "").replace(/'/g, "''");
  if (!rutaSegura) throw new ErrorAzure("Seleccione un sprint.");
  const wiql = await solicitar(enProyecto(proyecto, "wit/wiql?$top=1000"), {
    method: "POST",
    body: {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project
        AND [System.WorkItemType] IN ('User Story', 'Product Backlog Item')
        AND [System.IterationPath] UNDER '${rutaSegura}'
        ${areaSegura ? `AND [System.AreaPath] UNDER '${areaSegura}'` : ""}
        AND [System.State] <> 'Removed'
        ORDER BY [System.Id]`,
    },
  });
  const ids = (wiql?.workItems ?? []).map((w) => w.id);
  const historias = [];
  const proy = proyecto || config().proyecto;
  for (let i = 0; i < ids.length; i += 200) {
    const r = await solicitar(enProyecto(proyecto, `wit/workitems?ids=${ids.slice(i, i + 200).join(",")}&$expand=relations&errorPolicy=omit`));
    for (const w of r?.value ?? []) {
      if (!w) continue;
      const f = w.fields ?? {};
      historias.push({
        id: w.id,
        titulo: f["System.Title"] ?? "",
        tipo: f["System.WorkItemType"] ?? "",
        estado: f["System.State"] ?? "",
        asignado: nombrePersona(f["System.AssignedTo"]),
        area: f["System.AreaPath"] ?? "",
        iteracion: f["System.IterationPath"] ?? "",
        tags: lista(f["System.Tags"]),
        casos: (w.relations ?? []).filter((rel) => rel.rel === "Microsoft.VSTS.Common.TestedBy-Forward").length,
        enlace: w._links?.html?.href ?? `${config().url}/${encodeURIComponent(proy)}/_workitems/edit/${w.id}`,
      });
    }
  }
  return historias;
}
