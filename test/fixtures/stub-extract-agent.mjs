// A stand-in for the real map-pass agent, so tests cost nothing.
// Contract: argv[2] is the output path, argv[3] the document path.
import { writeFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { emptyExtract } from "../../scripts/lib/extract-schema.mjs";

const [, , outPath, docPath] = process.argv;
const text = readFileSync(docPath, "utf8");
const e = emptyExtract({ docId: basename(docPath), scope: "project", category: "documents" });
e.windows = [{ pageStart: 1, pageEnd: 1 }];
e.coverage = { pagesRead: 1, pagesTotal: 1, truncated: false };
if (/refund/i.test(text)) {
  e.businessFunctions.push({ name: "Refund Handling", does: "Handles refunds",
    src: { pageStart: 1, pageEnd: 1 } });
}
writeFileSync(outPath, JSON.stringify(e, null, 2));
