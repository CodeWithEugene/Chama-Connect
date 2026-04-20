import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * Smoke test against the running ChamaPay dev server.
 * Expects `npm run dev` running on port 3100.
 * Produces a single screenshot we use in the demo / README.
 */

test.use({ baseURL: "http://localhost:3100" });

test("chamapay dashboard renders and shows seeded members", async ({ page }) => {
  const outDir = path.resolve(__dirname, "..", "artifacts", "chamapay");
  fs.mkdirSync(outDir, { recursive: true });

  await page.goto("/chamas/ACME", { waitUntil: "networkidle" });
  await expect(page.getByText("Acme Savers Chama")).toBeVisible();
  await expect(page.getByText("Alice Wanjiru")).toBeVisible();
  await expect(page.getByText("Brian Otieno")).toBeVisible();
  await page.screenshot({
    path: path.join(outDir, "dashboard.png"),
    fullPage: true,
  });
});
