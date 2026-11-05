// Proveedor Claude (Anthropic): streaming + salida estructurada con JSON Schema.
import Anthropic from "@anthropic-ai/sdk";
import { ErrorGeneracion } from "../errores.js";

export const NOMBRE = "Claude (Anthropic)";
export const MODELO = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// Mismo criterio que Gemini: menos razonamiento en esencial/estándar (mucho más rápido, igual cobertura).
const ESFUERZO = { esencial: "low", estandar: "medium", exhaustivo: "high" };

let clienteEnv;
const clientes = new Map();

/** `credenciales` (opcional) viene de "Conexión de IA" en el navegador; si no, se usa .env. */
export function tieneCredenciales(credenciales) {
  return Boolean(credenciales?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function clientePara(apiKey) {
  if (!apiKey) return (clienteEnv ??= new Anthropic());
  if (!clientes.has(apiKey)) {
    if (clientes.size > 50) clientes.clear();
    clientes.set(apiKey, new Anthropic({ apiKey }));
  }
  return clientes.get(apiKey);
}

/** @returns {Promise<{json:string, modelo:string, tokensEntrada:number, tokensSalida:number}>} */
export async function generar({ system, mensaje, imagenes = [], esquema, profundidad, onTexto, signal, credenciales }) {
  const contenido = [
    ...imagenes.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
    { type: "text", text: mensaje },
  ];
  const cliente = clientePara(credenciales?.apiKey);
  const stream = cliente.beta.messages.stream(
    {
      model: credenciales?.modelo || MODELO,
      max_tokens: 64000,
      // Si el modelo declina por un falso positivo de seguridad, la API reintenta con un modelo de respaldo.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: ESFUERZO[profundidad] ?? "high",
        format: { type: "json_schema", schema: esquema },
      },
      system,
      messages: [{ role: "user", content: contenido }],
    },
    { signal },
  );
  stream.on("text", (_delta, snapshot) => onTexto(snapshot));

  const respuesta = await stream.finalMessage();
  if (respuesta.stop_reason === "refusal") throw new ErrorGeneracion("rechazo");
  if (respuesta.stop_reason === "max_tokens") throw new ErrorGeneracion("limite");

  // Si hubo un cambio a modelo de respaldo, solo vale el texto posterior al último bloque "fallback".
  let inicio = 0;
  respuesta.content.forEach((b, i) => {
    if (b.type === "fallback") inicio = i + 1;
  });
  const json = respuesta.content
    .slice(inicio)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    json,
    modelo: respuesta.model,
    tokensEntrada: respuesta.usage.input_tokens,
    tokensSalida: respuesta.usage.output_tokens,
  };
}

/** Traduce errores del SDK de Anthropic; devuelve null si no los reconoce. */
export function traducirError(err) {
  if (err instanceof Anthropic.AuthenticationError)
    return "La API key de Anthropic es inválida. Revísela en \"Conexión de IA\" o en ANTHROPIC_API_KEY del archivo .env.";
  if (err instanceof Anthropic.PermissionDeniedError) return "La API key de Anthropic no tiene permisos para usar este modelo.";
  if (err instanceof Anthropic.RateLimitError) return "Se alcanzó el límite de uso de la API de Anthropic. Espere un momento e intente de nuevo.";
  if (err instanceof Anthropic.BadRequestError) return `Solicitud rechazada por la API de Anthropic: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "No fue posible conectarse con la API de Anthropic. Revise su conexión a internet.";
  if (err instanceof Anthropic.APIError)
    return `Error del servicio de Anthropic (${err.status ?? "sin código"}). Intente de nuevo en unos minutos.`;
  // El SDK valida las credenciales al enviar la petición, no al crear el cliente.
  if (err instanceof Anthropic.AnthropicError && !tieneCredenciales())
    return "No se encontró la API key de Anthropic. Configure ANTHROPIC_API_KEY en el archivo .env y reinicie el servidor.";
  return null;
}
