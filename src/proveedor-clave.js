// Detecta el proveedor de IA a partir de la API key. La persona solo pega la clave y la app
// elige Gemini, Claude o un servicio compatible con OpenAI (según el prefijo de la clave).
const REGLAS = [
  { prueba: /^AIza/, proveedor: "gemini", nombre: "Gemini (Google)" },
  { prueba: /^AQ\./, proveedor: "gemini", nombre: "Gemini (Google)" },
  { prueba: /^sk-ant-/, proveedor: "anthropic", nombre: "Claude (Anthropic)" },
  { prueba: /^sk-or-v1-/, proveedor: "openai", nombre: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { prueba: /^gsk_/, proveedor: "openai", nombre: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { prueba: /^xai-/, proveedor: "openai", nombre: "xAI", baseUrl: "https://api.x.ai/v1" },
  { prueba: /^sk-(?:proj|svcacct|admin)-/, proveedor: "openai", nombre: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { prueba: /^sk-/, proveedor: "openai", nombre: "Compatible con OpenAI", baseUrl: "https://api.openai.com/v1" },
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

/**
 * @param {string} apiKey
 * @param {{baseUrl?: string}} [opciones]
 * @returns {{proveedor: "gemini"|"anthropic"|"openai", nombre: string, baseUrl: string}|null}
 */
export function detectarProveedor(apiKey, { baseUrl = "" } = {}) {
  const clave = String(apiKey ?? "").trim();
  if (!clave) return null;
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const regla = REGLAS.find((r) => r.prueba.test(clave));
  // Una Base URL propia convierte una clave desconocida en un proveedor compatible con OpenAI.
  const proveedor = regla?.proveedor ?? (base ? "openai" : null);
  if (!proveedor) return null;
  const url = proveedor === "openai" ? base || regla?.baseUrl || "" : "";
  return {
    proveedor,
    nombre: nombreDeBase(url) || regla?.nombre || "Compatible con OpenAI",
    baseUrl: url,
  };
}
