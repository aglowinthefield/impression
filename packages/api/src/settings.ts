import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { userSettings } from "./db/schema.js";

/** Extraction keeps candidates at or above this confidence unless the person changed it. */
export const DEFAULT_EXTRACTION_FLOOR = 0.7;

export async function getExtractionFloor(db: Db, owner: string) {
  const [row] = await db
    .select({ floor: userSettings.extractionFloor })
    .from(userSettings)
    .where(eq(userSettings.owner, owner));
  return row?.floor ?? DEFAULT_EXTRACTION_FLOOR;
}

const putBody = z.object({
  extractionFloor: z.number().min(0).max(1),
});

/** The signed-in person's own settings. */
export function settingsRoutes(db: Db) {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) =>
    c.json({
      extractionFloor: await getExtractionFloor(db, c.get("principal")),
    }),
  );

  app.put("/", async (c) => {
    const parsed = putBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const { extractionFloor } = parsed.data;
    await db
      .insert(userSettings)
      .values({ owner: c.get("principal"), extractionFloor })
      .onConflictDoUpdate({
        target: userSettings.owner,
        set: { extractionFloor, updatedAt: new Date() },
      });
    return c.json({ extractionFloor });
  });

  return app;
}
