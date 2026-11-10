// The build copies the icon next to the compiled nodes, where n8n looks for it.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist/nodes/ContactFormOutreach", { recursive: true });
copyFileSync("nodes/ContactFormOutreach/contactformoutreach.svg", "dist/nodes/ContactFormOutreach/contactformoutreach.svg");
