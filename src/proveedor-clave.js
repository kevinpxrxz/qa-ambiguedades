// Detecta el proveedor de IA a partir de la API key. La persona solo pega la clave y la app
// elige Gemini, Claude o un servicio compatible con OpenAI (según el prefijo de la clave).
const REGLAS = [
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

const NOMBRES_BASE = [
  [/opencode\.ai/i, "OpenCode"],
  [/deepseek\.com/i, "DeepSeek"],
  [/openrouter\.ai/i, "OpenRouter"],
  [/groq\.com/i, "Groq"],
  [/mistral\.ai/i, "Mistral"],
  [/api\.x\.ai/i, "xAI"],
  [/localhost|127\.0\.0\.1/i, "Local (Ollama/LM Studio)"],
];

function nombreDeBase(url) {
  return NOMBRES_BASE.find(([patron]) => patron.test(url))?.[1] ?? "";
}

/** Si la clave es genérica `sk-`, el modelo ayuda a saber el servicio (ej. deepseek-chat). */
function sugerenciaModelo(modelo) {
  const valor = String(modelo ?? "").trim();
  if (/^deepseek/i.test(valor)) return { nombre: "DeepSeek", baseUrl: "https://api.deepseek.com" };
  if (/^(gpt-|o[1-9])/i.test(valor)) return { nombre: "OpenAI", baseUrl: "https://api.openai.com/v1" };
  return null;
}

/**
 * @param {string} apiKey
 * @param {{baseUrl?: string, modelo?: string}} [opciones]
 * @returns {{proveedor: "gemini"|"anthropic"|"openai", nombre: string, baseUrl: string}|null}
 */
export function detectarProveedor(apiKey, { baseUrl = "", modelo = "" } = {}) {
  const clave = String(apiKey ?? "").trim();
  if (!clave) return null;
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const regla = REGLAS.find((r) => r.prueba.test(clave));
  // Una Base URL propia convierte una clave desconocida en un proveedor compatible con OpenAI.
  const proveedor = regla?.proveedor ?? (base ? "openai" : null);
  if (!proveedor) return null;
  const pista = proveedor === "openai" && (!regla || regla.generico) ? sugerenciaModelo(modelo) : null;
  const url = proveedor === "openai" ? base || pista?.baseUrl || regla?.baseUrl || "https://api.openai.com/v1" : "";
  return {
    proveedor,
    nombre: nombreDeBase(url) || pista?.nombre || regla?.nombre || "Compatible con OpenAI",
    baseUrl: url,
  };
}
