import fs from "fs";
import crypto from "crypto";
import path from "path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { fileURLToPath } from "url";

// Resolve absolute path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ABSOLUTE path to node_modules/standard_fonts/
const standardFontsPath =
  path.resolve(__dirname, "../node_modules/pdfjs-dist/standard_fonts/") + "/";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
pdfjsLib.GlobalWorkerOptions.standardFontDataUrl = standardFontsPath;
// -----------------------------
// Extract Text Layout From PDF
// -----------------------------
export async function extractLayoutSignature(pdfPath) {
  const pdfPathResolved = path.resolve("uploads", pdfPath);

  const pdf_fingerprint = crypto
    .createHash("sha256")
    .update(pdfPathResolved)
    .digest("hex");

  const data = new Uint8Array(fs.readFileSync(pdfPathResolved));
  const pdfDoc = await pdfjsLib.getDocument({
    data,
    standardFontDataUrl: standardFontsPath,
  }).promise;
  const sample_text = await extractSampleText(pdfDoc);
  // console.log("Sample Text:", sample_text);
  const supplierName = extractSupplierName(sample_text);
  console.log("Supplier Name:", supplierName);

  let layout = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    textContent.items.forEach((item) => {
      const [, , , , x, y] = item.transform;
      const w = item.width;
      const h = item.height;
      layout.push({
        page: pageNum,
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        w: Number(w.toFixed(2)),
        h: Number(h.toFixed(2)),
      });
    });
  }
  layout.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);

  return { layout, pdf_fingerprint, supplierName, sample_text };
}

export function generateStructureHash(layoutArray) {
  const serialized = JSON.stringify(layoutArray);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export async function run(pdfPath) {
  try {
    console.log("Extracting layout signature...");
    const { layout, pdf_fingerprint, supplierName, sample_text } =
      await extractLayoutSignature(`${pdfPath}`);
    console.log("Layout count:", layout.length);
    const hash = generateStructureHash(layout);
    console.log("Structure Hash:", hash);
    return { hash, layout, pdf_fingerprint, supplierName, sample_text };
  } catch (error) {
    console.error("Error in SCE processing:", error);
  }
}

export async function extractSampleText(pdfData) {
  const pdf = pdfData;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();

  return content.items.map((i) => i.str).join(" ");
}
function extractSupplierName(text) {
  const regex =
    /(invoice|bill|vendor|vendor number|vendor name) from[:\s]*([A-Za-z0-9 &.-]+)/i;
  const match = text.match(regex);
  return match ? match[2].trim() : null;
}
