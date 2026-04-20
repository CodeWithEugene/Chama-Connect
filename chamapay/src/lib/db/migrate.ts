import * as fs from "fs";
import * as path from "path";
import { getDb } from "./client";

const schemaPath = path.resolve(__dirname, "schema.sql");

function main() {
  const db = getDb();
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);
  console.log("[migrate] applied schema.sql");
}

main();
