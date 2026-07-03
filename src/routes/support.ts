// ─── src/routes/support.ts ───────────────────────────────────────────────────
//
// Route pour recevoir les messages du formulaire "Contactez-nous".
// Les messages sont stockés dans la table SupportMessage pour consultation
// manuelle (Railway PostgreSQL Query Tab) ou future interface admin.

import { Router } from "express";
import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import { db } from "../db/client.js";

const router = Router();

const contactSchema = z.object({
  userId: z.string().trim().min(10).max(100).optional(),
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(2000),
  contactEmail: z.string().trim().email().max(200).optional().or(z.literal("")),
});

// POST /support/contact
router.post("/contact", async (req: Request, res: Response) => {
  try {
    const parsed = contactSchema.parse(req.body);

    const supportMessage = await db.supportMessage.create({
      data: {
        userId: parsed.userId ?? null,
        subject: parsed.subject,
        message: parsed.message,
        contactEmail: parsed.contactEmail || null,
        status: "OPEN",
      },
    });

    console.log(`📩 New support message from ${parsed.userId ?? "anonymous"}: ${parsed.subject}`);

    return res.status(201).json({
      ok: true,
      messageId: supportMessage.id,
      message: "Support message received.",
    });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: "Invalid contact form payload",
        details: err.flatten(),
      });
    }
    console.error("POST /support/contact error:", err);
    return res.status(500).json({ error: "Failed to submit support message" });
  }
});

// GET /support/messages — pour consultation admin (à protéger avec auth plus tard)
router.get("/messages", async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const messages = await db.supportMessage.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return res.json(messages);
  } catch (err) {
    console.error("GET /support/messages error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

export default router;
