// ─── src/routes/contacts.ts ──────────────────────────────────────────────────
// CRUD des contacts d'urgence multi-contacts (Basic = jusqu'à 3).
//
// ENFORCEMENT CÔTÉ SERVEUR (le frontend n'est jamais la source de vérité) :
//   - POST refuse au-delà de PLAN_LIMITS[plan].maxContacts
//     → 403 { code: "PLAN_LIMIT_CONTACTS" } — le frontend affiche le paywall
//   - Toujours AU MOINS 1 contact, et AU MOINS 1 contact activé
//     (app de sécurité : un utilisateur ne peut pas se retrouver sans contact)
//
// ROUTES :
//   GET    /contacts/:userId        → { plan, maxContacts, contacts[] }
//   POST   /contacts                → ajoute (priorité suivante auto)
//   PATCH  /contacts/reorder        → réordonne la cascade (ordre d'appel)
//   PATCH  /contacts/:id            → modifie (nom, tél, relation, enabled)
//   DELETE /contacts/:id            → supprime + renormalise les priorités

import { Router } from "express";
import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import { db } from "../db/client.js";
import { PLAN_LIMITS, resolveUserPlan } from "../services/plan.js";

const router = Router();

// ─── SCHEMAS ─────────────────────────────────────────────────────────────────

const userIdSchema = z.string().trim().min(10).max(100);
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164 (+15551234567)");

const createContactSchema = z.object({
  userId: userIdSchema,
  name: z.string().trim().min(1).max(100),
  phoneNumber: phoneSchema,
  relationship: z.string().trim().max(100).optional(),
});

const updateContactSchema = z.object({
  userId: userIdSchema,
  name: z.string().trim().min(1).max(100).optional(),
  phoneNumber: phoneSchema.optional(),
  relationship: z.string().trim().max(100).nullable().optional(),
  enabled: z.boolean().optional(),
});

const reorderSchema = z.object({
  userId: userIdSchema,
  // Liste COMPLÈTE des ids de contacts, dans le nouvel ordre d'appel
  order: z.array(z.string().trim().min(10).max(100)).min(1).max(10),
});

function param(value: string | string[] | undefined): string {
  if (!value) return "";
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

// ─── GET /contacts/:userId ───────────────────────────────────────────────────

router.get("/:userId", async (req: Request, res: Response) => {
  try {
    const userId = param(req.params.userId);
    if (!/^c[a-z0-9]{24,}$/.test(userId)) {
      return res.status(400).json({ error: "Invalid userId format" });
    }

    const [plan, contacts] = await Promise.all([
      resolveUserPlan(userId),
      db.emergencyContact.findMany({
        where: { userId },
        orderBy: { priority: "asc" },
      }),
    ]);

    return res.json({
      plan,
      maxContacts: PLAN_LIMITS[plan].maxContacts,
      contacts,
    });
  } catch (err) {
    console.error("GET /contacts/:userId error:", err);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

// ─── POST /contacts ──────────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = createContactSchema.parse(req.body);
    const { userId, name, phoneNumber, relationship } = parsed;

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const [plan, existing] = await Promise.all([
      resolveUserPlan(userId),
      db.emergencyContact.findMany({
        where: { userId },
        orderBy: { priority: "asc" },
        select: { priority: true, phoneNumber: true },
      }),
    ]);

    const maxContacts = PLAN_LIMITS[plan].maxContacts;

    // ENFORCEMENT PLAN — le frontend affiche le paywall sur ce code d'erreur
    if (existing.length >= maxContacts) {
      return res.status(403).json({
        error: "Emergency contact limit reached for current plan",
        code: "PLAN_LIMIT_CONTACTS",
        plan,
        maxContacts,
      });
    }
    if (existing.some((c) => c.phoneNumber === phoneNumber)) {
      return res.status(409).json({
        error: "This phone number is already an emergency contact",
        code: "DUPLICATE_PHONE",
      });
    }

    const nextPriority =
      existing.length > 0
        ? Math.max(...existing.map((c) => c.priority)) + 1
        : 1;

    const contact = await db.emergencyContact.create({
      data: {
        userId,
        name,
        phoneNumber,
        relationship: relationship || null,
        priority: nextPriority,
        enabled: true,
      },
    });

    console.log(
      `👥 Contact added for user ${userId} (priority ${nextPriority}, plan ${plan})`,
    );
    return res.status(201).json({ ok: true, contact });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid contact payload", details: err.flatten() });
    }
    console.error("POST /contacts error:", err);
    return res.status(500).json({ error: "Create failed" });
  }
});

// ─── PATCH /contacts/reorder ─────────────────────────────────────────────────
// IMPORTANT : déclaré AVANT PATCH /:id sinon Express matche "reorder" comme :id

router.patch("/reorder", async (req: Request, res: Response) => {
  try {
    const parsed = reorderSchema.parse(req.body);
    const { userId, order } = parsed;

    const contacts = await db.emergencyContact.findMany({
      where: { userId },
      select: { id: true },
    });

    const existingIds = new Set(contacts.map((c) => c.id));
    const orderIds = new Set(order);

    // L'ordre doit être une permutation EXACTE des contacts de l'utilisateur
    if (
      existingIds.size !== orderIds.size ||
      [...orderIds].some((id) => !existingIds.has(id))
    ) {
      return res.status(400).json({
        error: "Order must contain exactly all the user's contact ids",
      });
    }

    // Contrainte unique (userId, priority) → 2 passes en transaction :
    // 1) priorités temporaires hors plage, 2) priorités finales 1..n
    await db.$transaction([
      ...order.map((id, index) =>
        db.emergencyContact.update({
          where: { id },
          data: { priority: 1000 + index },
        }),
      ),
      ...order.map((id, index) =>
        db.emergencyContact.update({
          where: { id },
          data: { priority: index + 1 },
        }),
      ),
    ]);

    const updated = await db.emergencyContact.findMany({
      where: { userId },
      orderBy: { priority: "asc" },
    });

    console.log(`🔀 Contacts reordered for user ${userId}`);
    return res.json({ ok: true, contacts: updated });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid reorder payload", details: err.flatten() });
    }
    console.error("PATCH /contacts/reorder error:", err);
    return res.status(500).json({ error: "Reorder failed" });
  }
});

// ─── PATCH /contacts/:id ─────────────────────────────────────────────────────

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const contactId = param(req.params.id);
    const parsed = updateContactSchema.parse(req.body);
    const { userId, name, phoneNumber, relationship, enabled } = parsed;

    const contact = await db.emergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!contact || contact.userId !== userId) {
      return res.status(404).json({ error: "Contact not found" });
    }

    // App de sécurité : impossible de désactiver le DERNIER contact activé
    if (enabled === false && contact.enabled === true) {
      const otherEnabled = await db.emergencyContact.count({
        where: { userId, enabled: true, id: { not: contactId } },
      });
      if (otherEnabled === 0) {
        return res.status(400).json({
          error: "At least one emergency contact must remain enabled",
          code: "AT_LEAST_ONE_ENABLED",
        });
      }
    }
    if (phoneNumber !== undefined && phoneNumber !== contact.phoneNumber) {
      const duplicate = await db.emergencyContact.findFirst({
        where: { userId, phoneNumber, id: { not: contactId } },
        select: { id: true },
      });
      if (duplicate) {
        return res.status(409).json({
          error: "This phone number is already an emergency contact",
          code: "DUPLICATE_PHONE",
        });
      }
    }

    const updated = await db.emergencyContact.update({
      where: { id: contactId },
      data: {
        ...(name !== undefined && { name }),
        ...(phoneNumber !== undefined && { phoneNumber }),
        ...(relationship !== undefined && {
          relationship: relationship || null,
        }),
        ...(enabled !== undefined && { enabled }),
      },
    });

    return res.json({ ok: true, contact: updated });
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid update payload", details: err.flatten() });
    }
    console.error("PATCH /contacts/:id error:", err);
    return res.status(500).json({ error: "Update failed" });
  }
});

// ─── DELETE /contacts/:id ────────────────────────────────────────────────────
// userId via header x-user-id (déjà envoyé par l'intercepteur axios de l'app)

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const contactId = param(req.params.id);
    const userId = param(req.headers["x-user-id"] as string | string[]);

    if (!userId) {
      return res.status(400).json({ error: "Missing x-user-id header" });
    }

    const contact = await db.emergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!contact || contact.userId !== userId) {
      return res.status(404).json({ error: "Contact not found" });
    }

    const total = await db.emergencyContact.count({ where: { userId } });
    if (total <= 1) {
      return res.status(400).json({
        error: "Cannot delete the last emergency contact",
        code: "LAST_CONTACT",
      });
    }

    await db.emergencyContact.delete({ where: { id: contactId } });

    // Renormalise les priorités en 1..n (2 passes — contrainte unique)
    const remaining = await db.emergencyContact.findMany({
      where: { userId },
      orderBy: { priority: "asc" },
      select: { id: true },
    });
    await db.$transaction([
      ...remaining.map((c, index) =>
        db.emergencyContact.update({
          where: { id: c.id },
          data: { priority: 1000 + index },
        }),
      ),
      ...remaining.map((c, index) =>
        db.emergencyContact.update({
          where: { id: c.id },
          data: { priority: index + 1 },
        }),
      ),
    ]);

    // Garantit au moins un contact activé après suppression
    const enabledCount = await db.emergencyContact.count({
      where: { userId, enabled: true },
    });
    if (enabledCount === 0 && remaining[0]) {
      await db.emergencyContact.update({
        where: { id: remaining[0].id },
        data: { enabled: true },
      });
      console.log(
        `⚠️ No enabled contact left after delete — re-enabled priority 1 for user ${userId}`,
      );
    }

    console.log(`🗑️ Contact ${contactId} deleted for user ${userId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /contacts/:id error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

export default router;