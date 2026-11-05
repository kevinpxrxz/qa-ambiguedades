// Análisis de ambigüedades de una HU con el proveedor de IA configurado (Gemini, Claude o compatible con OpenAI).
// Reutiliza los mismos proveedores del Ecosistema de Aseguramiento de Calidad TI.
import * as anthropic from "./proveedores/anthropic.js";
import * as gemini from "./proveedores/gemini.js";
import * as openai from "./proveedores/openai.js";

const PROVEEDORES = { anthropic, gemini };
const MODULOS_IA = { anthropic, gemini, openai };

export function proveedorActivo() {
  const elegido = (process.env.PROVEEDOR_IA || "").trim().toLowerCase();
  if (PROVEEDORES[elegido]) return PROVEEDORES[elegido];
  if (!anthropic.tieneCredenciales() && gemini.tieneCredenciales()) return gemini;
  return anthropic;
}

/** Proveedor a usar; `ia` = { proveedor, apiKey, modelo, baseUrl } (opcional, desde el navegador). */
export function resolverIA(ia) {
  if (ia && MODULOS_IA[ia.proveedor]) {
    const proveedor = MODULOS_IA[ia.proveedor];
    return {
      proveedor,
      credenciales: ia,
      nombre: ia.nombre || proveedor.NOMBRE,
      modelo: ia.modelo || proveedor.MODELO || "",
      configurado: proveedor.tieneCredenciales(ia),
    };
  }
  const proveedor = proveedorActivo();
  return { proveedor, credenciales: null, nombre: proveedor.NOMBRE, modelo: proveedor.MODELO, configurado: proveedor.tieneCredenciales() };
}

export function infoIA() {
  const r = resolverIA(null);
  const id = r.proveedor === anthropic ? "anthropic" : r.proveedor === gemini ? "gemini" : "openai";
  return { proveedor: r.nombre, proveedorId: id, modelo: r.modelo, configurado: r.configurado };
}

/** Lee el JSON aunque venga con texto alrededor, bloques ```json o comas finales. */
export function parsearJson(texto) {
  const limpio = String(texto ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const candidatos = [limpio];
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio >= 0 && fin > inicio) candidatos.push(limpio.slice(inicio, fin + 1));
  for (const candidato of candidatos) {
    try {
      return JSON.parse(candidato);
    } catch {
      /* se prueba sin comas finales */
    }
    try {
      return JSON.parse(candidato.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

export const SYSTEM_AMBIGUEDADES = `Eres un Analista QA senior (ISTQB) especializado en análisis de requerimientos.
Tu única tarea es detectar ambigüedades, vacíos y preguntas abiertas en UNA historia de usuario (HU) para que el Product Owner o el negocio las responda. NO diseñas casos de prueba, NO escribes código y NO propones soluciones.

Revisa, entre otros: descripción, criterios de aceptación, reglas de negocio, datos y validaciones, límites y rangos, mensajes al usuario, permisos y roles, estados y transiciones, excepciones, integraciones y dependencias.

Reglas:
- Cada pregunta debe ser concreta, respondible y relevante para poder probar la HU.
- Asigna cada pregunta al criterio de aceptación afectado usando el ID que aparezca en la HU (ej. "CA-01"); si afecta a toda la HU o a varios criterios, usa "General".
- No inventes criterios que no estén en la HU.
- No repitas preguntas ni preguntes lo que la HU ya define con claridad.
- Ordena las preguntas de mayor a menor impacto. Máximo 20.
- Si el texto no es un requerimiento válido, marca es_entrada_valida=false y explica el motivo en motivo_rechazo.
- Devuelve SOLO el objeto JSON del esquema, sin texto antes ni después y sin bloques de código.`;

export const ESQUEMA_AMBIGUEDADES = {
  type: "object",
  properties: {
    es_entrada_valida: { type: "boolean" },
    motivo_rechazo: { type: "string" },
    titulo_requerimiento: { type: "string" },
    resumen_requerimiento: { type: "string" },
    criterios_aceptacion: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, descripcion: { type: "string" } },
        required: ["id", "descripcion"],
      },
    },
    ambiguedades_y_preguntas: {
      type: "array",
      items: {
        type: "object",
        properties: { criterio: { type: "string" }, pregunta: { type: "string" } },
        required: ["criterio", "pregunta"],
      },
    },
    supuestos: { type: "array", items: { type: "string" } },
  },
  required: ["es_entrada_valida", "titulo_requerimiento", "resumen_requerimiento", "criterios_aceptacion", "ambiguedades_y_preguntas", "supuestos"],
};

function normalizar(datos) {
  const criterios = (Array.isArray(datos.criterios_aceptacion) ? datos.criterios_aceptacion : [])
    .map((c) => ({ id: String(c?.id ?? "").trim(), descripcion: String(c?.descripcion ?? "").trim() }))
    .filter((c) => c.id || c.descripcion);
  const ids = new Set(criterios.map((c) => c.id));
  const preguntas = (Array.isArray(datos.ambiguedades_y_preguntas) ? datos.ambiguedades_y_preguntas : [])
    .map((a) =>
      typeof a === "string"
        ? { criterio: "General", pregunta: a }
        : { criterio: String(a?.criterio ?? "General").trim() || "General", pregunta: String(a?.pregunta ?? "").trim() },
    )
    .filter((a) => a.pregunta);
  // Un criterio que no existe en la HU se manda a "General" para no inventar IDs.
  for (const p of preguntas) if (p.criterio !== "General" && !ids.has(p.criterio)) p.criterio = "General";
  return {
    es_entrada_valida: datos.es_entrada_valida !== false,
    motivo_rechazo: String(datos.motivo_rechazo ?? "").trim(),
    titulo_requerimiento: String(datos.titulo_requerimiento ?? "").trim(),
    resumen_requerimiento: String(datos.resumen_requerimiento ?? "").trim(),
    criterios_aceptacion: criterios,
    ambiguedades_y_preguntas: preguntas,
    supuestos: (Array.isArray(datos.supuestos) ? datos.supuestos : []).map((s) => String(s).trim()).filter(Boolean),
  };
}

/**
 * Analiza UNA HU y devuelve solo sus ambigüedades.
 * @param {{texto:string, imagenes?:{mediaType:string, base64:string}[], ia?:object}} p
 */
export async function analizarAmbiguedades({ texto, imagenes = [], ia = null }) {
  const { proveedor, credenciales, nombre, modelo, configurado } = resolverIA(ia);
  if (!configurado) throw new Error("No hay una conexión de IA configurada (revisa PROVEEDOR_IA y su API key en .env).");

  const peticion = {
    system: SYSTEM_AMBIGUEDADES,
    mensaje: `Historia de usuario a analizar:\n\n${String(texto ?? "").trim()}`,
    imagenes: imagenes.map((img) => ({ mediaType: img.mediaType, data: img.base64 })),
    esquema: ESQUEMA_AMBIGUEDADES,
    profundidad: "esencial",
    onTexto: () => {},
    credenciales,
  };

  // La IA a veces responde "saturado" (503/529) o falla de forma pasajera: se reintenta con espera creciente.
  const ESPERAS_MS = [4000, 10000, 20000];
  let respuesta;
  for (let intento = 0; ; intento++) {
    try {
      respuesta = await proveedor.generar(peticion);
      break;
    } catch (err) {
      const temporal = [429, 500, 502, 503, 504, 529].includes(Number(err?.status));
      if (!temporal || intento >= ESPERAS_MS.length) {
        const traducido = proveedor.traducirError?.(err);
        throw new Error(traducido || err?.message || String(err));
      }
      await new Promise((resolver) => setTimeout(resolver, ESPERAS_MS[intento]));
    }
  }

  const datos = parsearJson(respuesta.json);
  if (!datos) throw new Error("La IA no devolvió un JSON válido. Vuelva a intentarlo.");
  return {
    datos: normalizar(datos),
    meta: { proveedor: nombre, modelo: respuesta.modelo, tokens_entrada: respuesta.tokensEntrada, tokens_salida: respuesta.tokensSalida },
  };
}
