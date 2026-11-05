// Análisis de ambigüedades con IA desde el navegador (GitHub Pages). No hay servidor:
// la API key y el modelo se guardan en este navegador y viajan directamente al proveedor.

export function leerIA() {
  try {
    const c = JSON.parse(localStorage.getItem("qa_amb_config") || "{}");
    return c.ia ?? {};
  } catch {
    return {};
  }
}

const SYSTEM = `Eres un Analista QA senior (ISTQB) especializado en análisis de requerimientos.
Tu única tarea es detectar ambigüedades, vacíos y preguntas abiertas en UNA historia de usuario (HU) para que el Product Owner o el negocio las responda. NO diseñas casos de prueba, NO escribes código y NO propones soluciones.

Revisa, entre otros: descripción, criterios de aceptación, reglas de negocio, datos y validaciones, límites y rangos, mensajes al usuario, permisos y roles, estados y transiciones, excepciones, integraciones y dependencias.

Reglas:
- Cada pregunta debe ser concreta, respondible y relevante para poder probar la HU.
- Asigna cada pregunta al criterio de aceptación afectado usando el ID que aparezca en la HU (ej. "CA-01"); si afecta a toda la HU o a varios criterios, usa "General".
- No inventes criterios que no estén en la HU.
- No repitas preguntas ni preguntes lo que la HU ya define con claridad.
- Ordena las preguntas de mayor a menor impacto. Máximo 20.
- Si el texto no es un requerimiento válido, marca es_entrada_valida=false y explica el motivo en motivo_rechazo.
- Devuelve SOLO el objeto JSON, sin texto antes ni después y sin bloques de código, con esta forma:
{
  "es_entrada_valida": true,
  "motivo_rechazo": "",
  "titulo_requerimiento": "",
  "resumen_requerimiento": "",
  "criterios_aceptacion": [{ "id": "CA-01", "descripcion": "" }],
  "ambiguedades_y_preguntas": [{ "criterio": "CA-01", "pregunta": "" }],
  "supuestos": [""]
}`;

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
      /* siguiente */
    }
  }
  return null;
}

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

function textoDeGemini(j) {
  return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** Reintenta cuando el proveedor responde saturado (429/5xx). */
async function conReintentos(fn) {
  const esperas = [2000, 5000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = Number(err?.status);
      if (![429, 500, 502, 503, 504, 529].includes(status) || i >= esperas.length) throw err;
      await new Promise((r) => setTimeout(r, esperas[i]));
    }
  }
}

async function gemini(ia, mensaje, modelo) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(ia.apiKey)}`;
  const r = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: mensaje }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8192 },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || `Gemini respondió ${r.status}.`);
    e.status = r.status;
    throw e;
  }
  return textoDeGemini(j);
}

async function openai(ia, mensaje) {
  const base = (ia.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ia.apiKey}` },
    body: JSON.stringify({
      model: ia.modelo || "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: mensaje },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || `La IA respondió ${r.status}.`);
    e.status = r.status;
    throw e;
  }
  return j.choices?.[0]?.message?.content ?? "";
}

async function anthropic(ia, mensaje) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ia.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: ia.modelo || "claude-sonnet-4-5",
      max_tokens: 8192,
      system: SYSTEM,
      messages: [{ role: "user", content: mensaje }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || `Claude respondió ${r.status}.`);
    e.status = r.status;
    throw e;
  }
  return (j.content ?? []).map((b) => b.text ?? "").join("");
}

export async function analizarAmbiguedades({ texto }) {
  const ia = leerIA();
  if (!ia.proveedor || !ia.apiKey) throw new Error("Configure la IA en ⚙ Configuración.");
  const mensaje = `Historia de usuario a analizar:\n\n${String(texto ?? "").trim()}`;

  let crudo;
  if (ia.proveedor === "gemini") {
    // Si el modelo elegido está saturado (503), se prueban alternativas.
    const modelos = [...new Set([ia.modelo, "gemini-3.6-flash", "gemini-3.5-flash"].filter(Boolean))];
    for (const modelo of modelos) {
      try {
        crudo = await conReintentos(() => gemini(ia, mensaje, modelo));
        break;
      } catch (err) {
        if (Number(err?.status) !== 503) throw err;
      }
    }
    if (!crudo) throw new Error("El modelo de Gemini está saturado (503). Cambie de modelo en ⚙ Configuración o use otro proveedor.");
  } else if (ia.proveedor === "anthropic") {
    crudo = await conReintentos(() => anthropic(ia, mensaje));
  } else {
    crudo = await conReintentos(() => openai(ia, mensaje));
  }

  const datos = parsearJson(crudo);
  if (!datos) throw new Error("La IA no devolvió un JSON válido. Intente de nuevo.");
  return { datos: normalizar(datos), meta: { proveedor: ia.proveedor, modelo: ia.modelo || "" } };
}
