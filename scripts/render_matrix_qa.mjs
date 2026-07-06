import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { writeFile } from "node:fs/promises";

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(process.argv[2]));
const preview = await workbook.render({ sheetName: "逐题分析矩阵", range: "A1:H7", scale: 1.5, format: "png" });
await writeFile(process.argv[3], new Uint8Array(await preview.arrayBuffer()));
const check = await workbook.inspect({ kind: "table", range: "逐题分析矩阵!A1:H7", include: "values,formulas", tableMaxRows: 7, tableMaxCols: 8 });
console.log(check.ndjson);
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 50 }, summary: "final formula error scan" });
console.log(errors.ndjson);
