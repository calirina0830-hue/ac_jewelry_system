import { readFileSync } from "node:fs";
import { join } from "node:path";

import pdfmake from "pdfmake";

import type { PdfDocumentDefinition } from "@/lib/reservations/invoice-document";

// pdfmake's bundled Roboto covers the Philippine peso sign (U+20B1), which the
// built-in WinAnsi fonts cannot render. The TTFs are loaded from node_modules
// into pdfmake's in-memory file system so no runtime file lookups leak out.
const FONT_FILES: Record<"normal" | "bold" | "italics" | "bolditalics", string> = {
  normal: "fonts/Roboto/Roboto-Regular.ttf",
  bold: "fonts/Roboto/Roboto-Medium.ttf",
  italics: "fonts/Roboto/Roboto-Italic.ttf",
  bolditalics: "fonts/Roboto/Roboto-MediumItalic.ttf",
};

let configured = false;

function ensurePdfMake(): void {
  if (configured) return;

  const base = join(process.cwd(), "node_modules", "pdfmake");
  const fonts: Record<string, string> = {};

  for (const [style, relative] of Object.entries(FONT_FILES)) {
    const filename = relative.slice(relative.lastIndexOf("/") + 1);
    const data = readFileSync(join(base, relative), "base64");
    pdfmake.virtualfs.writeFileSync(filename, Buffer.from(data, "base64"));
    fonts[style] = filename;
  }

  pdfmake.setFonts({ Roboto: fonts });
  // No local files or remote URLs should ever be fetched while rendering.
  pdfmake.setLocalAccessPolicy(() => false);
  pdfmake.setUrlAccessPolicy(() => false);
  configured = true;
}

export async function renderPdf(
  document: PdfDocumentDefinition,
): Promise<Buffer> {
  ensurePdfMake();
  const pdf = pdfmake.createPdf(document);
  return pdf.getBuffer();
}
