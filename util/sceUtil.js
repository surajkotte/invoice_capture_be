import fs from "fs";
import crypto from "crypto";
import path from "path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  fileURLToPath
} from "url";

// Resolve absolute path
const __filename = fileURLToPath(
  import.meta.url);
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
  const pdfBytes = data;
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

  return {
    layout,
    pdf_fingerprint,
    supplierName,
    sample_text,
    pdfBytes,
    pdfDoc
  };
}

export function generateStructureHash(layoutArray) {
  const serialized = JSON.stringify(layoutArray);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export async function run(pdfPath) {
  try {
    console.log("Extracting layout signature...");
    const {
      layout,
      pdf_fingerprint,
      supplierName,
      sample_text,
      pdfBytes,
      pdfDoc
    } =
    await extractLayoutSignature(`${pdfPath}`);
    console.log("Layout count:", layout.length);
    const hash = generateStructureHash(layout);
    console.log("Structure Hash:", hash);
    return {
      hash,
      layout,
      pdf_fingerprint,
      supplierName,
      sample_text,
      pdfBytes,
      pdfDoc
    };
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
export async function extractInvoiceUsingTemplate(pdfBytes, fields, pdfDoc) {
  const extracted = {};
  console.log("in extract invoice using template");

  for (const f of fields) {
        const rects = {
      left: row.left_pos,
      bottom: row.bottom_pos,
      width: row.width,
      height: row.height,
    };
    const text = await extractTextByRect(pdfDoc, f.page_number, rects);
    extracted[f.field_label] = text || "";
  }
console.log("Extracted Fields:", extracted);
  return extracted;
}
function overlapRatio(a, b) {
  const xOverlap = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const yOverlap = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const overlap = xOverlap * yOverlap;

  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  return areaA === 0 ? 0 : overlap / areaA;
}

// export async function extractTextByRect(pdfBytes, pageNum, rect, pdf) {
//   const page = await pdf.getPage(pageNum);
  
//   // 1. Get viewport at scale 1.0 (Native PDF units)
//   const viewport = page.getViewport({ scale: 1.0 });
//   const pageWidth = viewport.width;
//   const pageHeight = viewport.height;

//   // 2. Handle property name mismatch safely
//   // UI sends: { left, top, ... }
//   // Backend might expect: { left_pos, top_pos, ... }
//   const rLeft = rect.left ?? rect.left_pos ?? 0;
//   const rTop = rect.top ?? rect.top_pos ?? 0;
//   const rWidth = rect.width ?? 0;
//   const rHeight = rect.height ?? 0;

//   // 3. Convert NORMALIZED (0-1) -> PDF ABSOLUTE COORDINATES
//   // PDF Origin is Bottom-Left. UI Origin is Top-Left.
//   const selectX = rLeft * pageWidth;
//   const selectWidth = rWidth * pageWidth;
//   const selectHeight = rHeight * pageHeight;
  
//   // Flip Y-axis: (Page Height) - (Top Offset) - (Height of Box)
//   const selectBottom = pageHeight - (rTop * pageHeight) - selectHeight;
//   const selectTop = selectBottom + selectHeight;

//   const selectionBox = {
//     xMin: selectX,
//     xMax: selectX + selectWidth,
//     yMin: selectBottom,
//     yMax: selectTop
//   };

//   // 4. Extract Text
//   const content = await page.getTextContent();
//   const results = [];

//   content.items.forEach((item) => {
//     // Transform matrix: [scaleX, skewY, skewX, scaleY, x, y]
//     const tx = item.transform;
//     const x = tx[4];
//     const y = tx[5];
    
//     // Accurate Dimensions
//     // Width: usually provided by PDF.js, or estimate fallback
//     const itemWidth = item.width || (item.str.length * (tx[0] * 0.5)); 
//     // Height: Use the Y-scale from transform matrix (index 3)
//     const itemHeight = Math.abs(tx[3]); 

//     // Calculate the CENTER point of the text item
//     const centerX = x + (itemWidth / 2);
//     const centerY = y + (itemHeight / 2);
//     // 5. Check if CENTER of text is INSIDE the selection box
//     // This is much safer than "edges overlap" which grabs neighbors
//     const isInside = 
//       centerX >= selectionBox.xMin &&
//       centerX <= selectionBox.xMax &&
//       centerY >= selectionBox.yMin &&
//       centerY <= selectionBox.yMax;

//     if (isInside) {
//       results.push({ str: item.str, x: x, y: y }); // Store x,y to sort later if needed
//     }
//   });

//   // Optional: Sort by Y (top to bottom) then X (left to right) for reading order
//   // Note: In PDF coords, higher Y is higher up the page.
//   results.sort((a, b) => {
//     if (Math.abs(a.y - b.y) > 5) return b.y - a.y; // Different lines
//     return a.x - b.x; // Same line, sort left to right
//   });

//   const finalStr = results.map(r => r.str).join(" ").trim();
//   console.log("Extracted:", finalStr);
//   return finalStr;
// }
export async function extractTextByRect(pdfDoc, pageNum, rect) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });

  // Convert normalized → absolute PDF coords
  const sel = {
    xMin: rect.left * viewport.width,
    xMax: (rect.left + rect.width) * viewport.width,
    yMin: rect.bottom * viewport.height,
    yMax: (rect.bottom + rect.height) * viewport.height,
  };

  const content = await page.getTextContent();
  const hits = [];

  for (const item of content.items) {
    const [ , , , , x, y ] = item.transform;
    const w = item.width || item.str.length * 5;
    const h = Math.abs(item.transform[3]) || 10;

    const box = {
      x1: x,
      x2: x + w,
      y1: y,
      y2: y + h,
    };

    if (overlapRatio(box, sel) > 0.6) {
      hits.push({ str: item.str, x, y });
    }
  }

  // Reading order
  hits.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 4) return b.y - a.y;
    return a.x - b.x;
  });

  return hits.map(h => h.str).join(" ").trim();
}
