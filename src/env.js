// Carga el .env ANTES de que se evalúen los módulos que leen process.env al importarse
// (por ejemplo, el modelo por defecto de cada proveedor de IA).
import dotenv from "dotenv";

dotenv.config();
