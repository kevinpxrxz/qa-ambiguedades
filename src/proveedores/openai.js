// Proveedor genérico para cualquier API compatible con OpenAI (OpenAI, DeepSeek, Groq, Mistral,
// OpenRouter, xAI, Ollama, Azure OpenAI…): streaming por SSE + salida JSON.
import { ErrorGeneracion } from "../errores.js";

export const NOMBRE = "Compatible con OpenAI";
export const URL_POR_DEFECTO = "https://api.openai.com/v1";

/** Error HTTP del proveedor, con el detalle que devolvió su API. */
export class ErrorProveedorIA extends Error {
  constructor(status, detalle, nombre) {
    super(detalle || `HTTP ${status}`);
    this.status = status;
    this.nombre = nombre;
  }
}

export function tieneCredenciales(credenciales) {
  return Boolean(credenciales?.apiKey || /localhost|127\.0\.0\.1/.test(credenciales?.baseUrl ?? ""));
}

function detalleDeError(texto) {
  try {
    const json = JSON.parse(texto);
    return String(json.error?.message ?? json.message ?? json.error ?? texto);
  } catch {
    return texto;
  }
}

/** @returns {Promise<{json:string, modelo:string, tokensEntrada:number, tokensSalida:number}>} */
export async function generar({ system, mensaje, imagenes = [], esquema, onTexto, signal, credenciales = {} }) {
  const base = (credenciales.baseUrl || URL_POR_DEFECTO).replace(/\/+$/, "");
  const modelo = credenciales.modelo;
  const nombre = credenciales.nombre || NOMBRE;
  if (!modelo) throw new ErrorGeneracion(`Indique el modelo de ${nombre} en "Conexión de IA".`);

  const usuario = imagenes.length
    ? [...imagenes.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } })), { type: "text", text: mensaje }]
    : mensaje;
  const headers = { "Content-Type": "application/json" };
  // OpenCode Go pide identificar al cliente y una sesión estable por conversación.
  if (/opencode\.ai/i.test(base)) {
    headers["User-Agent"] = "Ecosistema-Aseguramiento-Calidad-TI/1.0";
    headers["x-opencode-session"] = globalThis.crypto?.randomUUID?.() ?? `qa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  if (credenciales.apiKey) {
    headers.Authorization = `Bearer ${credenciales.apiKey}`;
    if (/azure/i.test(base)) headers["api-key"] = credenciales.apiKey;
  }

  const llamar = (formato) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: modelo,
        stream: true,
        ...(formato ? { response_format: formato } : {}),
        messages: [
          {
            role: "system",
            content:
              formato?.type === "json_schema"
                ? system
                : `${system}\n\nResponda únicamente con un objeto JSON válido que cumpla este JSON Schema:\n${JSON.stringify(esquema)}`,
          },
          { role: "user", content: usuario },
        ],
      }),
    });

  // Primero con JSON Schema; si el proveedor no lo soporta, con modo JSON y el esquema en las instrucciones.
  // OpenCode Go a veces devuelve un 400 sin decir "response_format": se prueban los tres formatos.
  const esOpenCode = /opencode\.ai/i.test(base);
  const intentos = [
    { type: "json_schema", json_schema: { name: "resultado", schema: esquema, strict: false } },
    { type: "json_object" },
    ...(esOpenCode ? [null] : []),
  ];
  let respuesta;
  let textoError = "";
  for (let i = 0; i < intentos.length; i++) {
    respuesta = await llamar(intentos[i]);
    if (respuesta.ok) break;
    textoError = await respuesta.text();
    if (respuesta.status !== 400 && respuesta.status !== 422) break;
    if (!esOpenCode && !/response_format|json_schema|schema/i.test(textoError)) break;
  }
  if (!respuesta.ok) throw new ErrorProveedorIA(respuesta.status, detalleDeError(textoError), nombre);

  let json = "";
  let finalizacion;
  let uso;
  let modeloUsado = modelo;
  let buffer = "";
  const decodificador = new TextDecoder();
  for await (const bloque of respuesta.body) {
    buffer += decodificador.decode(bloque, { stream: true });
    const lineas = buffer.split("\n");
    buffer = lineas.pop();
    for (const linea of lineas) {
      const datos = linea.trim();
      if (!datos.startsWith("data:")) continue;
      const contenido = datos.slice(5).trim();
      if (!contenido || contenido === "[DONE]") continue;
      let evento;
      try {
        evento = JSON.parse(contenido);
      } catch {
        continue;
      }
      if (evento.error) throw new ErrorProveedorIA(500, detalleDeError(JSON.stringify(evento)), nombre);
      const delta = evento.choices?.[0]?.delta?.content;
      if (delta) {
        json += delta;
        onTexto(json);
      }
      finalizacion = evento.choices?.[0]?.finish_reason ?? finalizacion;
      uso = evento.usage ?? uso;
      modeloUsado = evento.model ?? modeloUsado;
    }
  }

  if (finalizacion === "content_filter") throw new ErrorGeneracion("rechazo");
  if (finalizacion === "length") throw new ErrorGeneracion("limite");

  // Algunos modelos envuelven el JSON en un bloque ```json … ```.
  json = json.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return { json, modelo: modeloUsado, tokensEntrada: uso?.prompt_tokens ?? 0, tokensSalida: uso?.completion_tokens ?? 0 };
}

/** Traduce los errores de este proveedor; devuelve null si no los reconoce. */
export function traducirError(err) {
  if (!(err instanceof ErrorProveedorIA)) return null;
  const nombre = err.nombre || NOMBRE;
  switch (err.status) {
    case 401:
    case 403:
      return `La API key de ${nombre} es inválida o no tiene permisos. Revísela en "Conexión de IA".`;
    case 404:
      return `${nombre} no encontró el modelo o la URL indicada. Revise el modelo y la URL base en "Conexión de IA".`;
    case 429:
      return `Se alcanzó el límite de uso de ${nombre}. Espere un momento o revise el saldo de su cuenta.`;
    case 400:
      if (/opencode/i.test(nombre)) {
        return `OpenCode Go rechazó la solicitud (400). Verifique que su plan Go esté activo, que el modelo esté habilitado y que la región Global esté permitida en Console → Settings › Privacy. Detalle: ${err.message.slice(0, 200)}`;
      }
      return `Error de ${nombre} (400): ${err.message.slice(0, 300)}`;
    default:
      return `Error de ${nombre} (${err.status}): ${err.message.slice(0, 300)}`;
  }
}
