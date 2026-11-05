// Proveedor Gemini (Google): streaming + salida estructurada con JSON Schema.
import { GoogleGenAI, ApiError, FinishReason, ThinkingLevel } from "@google/genai";
import { ErrorGeneracion } from "../errores.js";

export const NOMBRE = "Gemini (Google)";
export const MODELO = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Medido con una HU real: el razonamiento alto tardaba ~33 s (24 s solo "pensando") y el medio ~16 s con la misma
// cobertura (mismos escenarios y criterios). Alto queda solo para la cobertura exhaustiva.
const NIVEL_RAZONAMIENTO = {
  esencial: ThinkingLevel.LOW,
  estandar: ThinkingLevel.MEDIUM,
  exhaustivo: ThinkingLevel.HIGH,
};
const BLOQUEOS = [FinishReason.SAFETY, FinishReason.PROHIBITED_CONTENT, FinishReason.BLOCKLIST, FinishReason.SPII, FinishReason.RECITATION];

const clientes = new Map();

/** `credenciales` (opcional) viene de "Conexión de IA" en el navegador; si no, se usa .env. */
export function tieneCredenciales(credenciales) {
  return Boolean(credenciales?.apiKey || process.env.GEMINI_API_KEY);
}

function clientePara(apiKey) {
  if (!clientes.has(apiKey)) {
    if (clientes.size > 50) clientes.clear();
    clientes.set(apiKey, new GoogleGenAI({ apiKey }));
  }
  return clientes.get(apiKey);
}

// Gemini no necesita additionalProperties (todos los campos ya son obligatorios); se quita para máxima compatibilidad.
function adaptarEsquema(nodo) {
  if (Array.isArray(nodo)) return nodo.map(adaptarEsquema);
  if (nodo && typeof nodo === "object") {
    return Object.fromEntries(
      Object.entries(nodo)
        .filter(([clave]) => clave !== "additionalProperties")
        .map(([clave, valor]) => [clave, adaptarEsquema(valor)]),
    );
  }
  return nodo;
}

/** @returns {Promise<{json:string, modelo:string, tokensEntrada:number, tokensSalida:number}>} */
export async function generar({ system, mensaje, imagenes = [], esquema, profundidad, onTexto, signal, credenciales }) {
  if (!tieneCredenciales(credenciales)) throw new ErrorGeneracion("sin_clave_gemini");
  const cliente = clientePara(credenciales?.apiKey || process.env.GEMINI_API_KEY);
  const modelo = credenciales?.modelo || MODELO;

  const stream = await cliente.models.generateContentStream({
    model: modelo,
    contents: [
      {
        role: "user",
        parts: [...imagenes.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })), { text: mensaje }],
      },
    ],
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseJsonSchema: adaptarEsquema(esquema),
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingLevel: NIVEL_RAZONAMIENTO[profundidad] ?? ThinkingLevel.HIGH },
      abortSignal: signal,
    },
  });

  let json = "";
  let finalizacion;
  let bloqueoEntrada;
  let uso;
  for await (const fragmento of stream) {
    const texto = fragmento.text;
    if (texto) {
      json += texto;
      onTexto(json);
    }
    finalizacion = fragmento.candidates?.[0]?.finishReason ?? finalizacion;
    bloqueoEntrada = fragmento.promptFeedback?.blockReason ?? bloqueoEntrada;
    uso = fragmento.usageMetadata ?? uso;
  }

  if (bloqueoEntrada || BLOQUEOS.includes(finalizacion)) throw new ErrorGeneracion("rechazo");
  if (finalizacion === FinishReason.MAX_TOKENS) throw new ErrorGeneracion("limite");

  return {
    json,
    modelo,
    tokensEntrada: uso?.promptTokenCount ?? 0,
    tokensSalida: (uso?.candidatesTokenCount ?? 0) + (uso?.thoughtsTokenCount ?? 0),
  };
}

/** Traduce errores del SDK de Google; devuelve null si no los reconoce. */
export function traducirError(err) {
  if (!(err instanceof ApiError)) return null;
  switch (err.status) {
    case 400:
      return /api key/i.test(err.message)
        ? "La API key de Gemini es inválida. Revísela en \"Conexión de IA\" o en GEMINI_API_KEY del archivo .env."
        : `Solicitud rechazada por la API de Gemini: ${err.message}`;
    case 401:
    case 403:
      return "La API key de Gemini es inválida o no tiene permisos. Revísela en \"Conexión de IA\" o en GEMINI_API_KEY del archivo .env.";
    case 404:
      return "El modelo de Gemini indicado no existe o no está disponible. Revise el modelo en \"Conexión de IA\" o GEMINI_MODEL en el archivo .env.";
    case 429:
      return "Se alcanzó el límite de uso de la API de Gemini. Espere un momento e intente de nuevo.";
    case 503:
      return 'Gemini está saturado en este momento (503); se reintentó varias veces sin éxito. Intente de nuevo en unos minutos o elija otro modelo en "Conexión de IA" (por ejemplo una versión "pro" o "flash-lite").';
    default:
      return `Error del servicio de Gemini (${err.status ?? "sin código"}). Intente de nuevo en unos minutos.`;
  }
}
