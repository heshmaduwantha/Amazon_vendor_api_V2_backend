import fs from "node:fs/promises";
import path from "node:path";
import { Workbook, SpreadsheetFile } from "@oai/artifact-tool";

const workDir = "/Users/heshanmaduwantha/Desktop/Amazon_prod/Amazon_vendor_api_V2_backend/outputs/inventory_export_2026_03_22_2026_03_28";
const csvPath = path.join(workDir, "inventory_2026-03-22_to_2026-03-28.csv");
const outputPath = path.join(workDir, "inventory_2026-03-22_to_2026-03-28_upload.xlsx");

const csvText = await fs.readFile(csvPath, "utf8");
const workbook = await Workbook.fromCSV(csvText, {
  sheetName: "inventory_2026-03-22_2026-03-28",
});

await fs.mkdir(workDir, { recursive: true });
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);

console.log(JSON.stringify({ outputPath, rows: csvText.trim().split(/\r?\n/).length - 1 }));
