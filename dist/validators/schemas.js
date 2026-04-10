import { z } from "zod";
export const emergencyContactSchema = z.object({
    name: z.string().trim().min(1, "Emergency contact name is required"),
    phoneNumber: z
        .string()
        .trim()
        .min(1, "Emergency contact phone number is required"),
    relationship: z.string().trim().optional().or(z.literal("")),
});
export const updateEmergencyContactSchema = z.object({
    userId: z.string().trim().min(1, "userId is required"),
    name: z.string().trim().min(1, "Emergency contact name is required"),
    phoneNumber: z
        .string()
        .trim()
        .min(1, "Emergency contact phone number is required"),
    relationship: z.string().trim().optional().default(""),
});
export const registerUserSchema = z.object({
    phoneNumber: z.string().trim().min(1, "Phone number is required"),
    firstName: z.string().trim().min(1, "First name is required"),
    address: z.string().trim().optional().default(""),
    city: z.string().trim().optional().default(""),
    country: z.string().trim().optional().default(""),
    zipCode: z.string().trim().optional().default(""),
    emergencyContact: emergencyContactSchema,
});
export const resolveAlertSchema = z.object({
    alertId: z.string().trim().min(1, "alertId is required"),
});
export const triggerAlertSchema = z.object({
    latitude: z.number().optional(),
    longitude: z.number().optional(),
});
export const updateLocationSchema = z.object({
    userId: z.string().trim().min(1, "userId is required"),
    lat: z.number(),
    lng: z.number(),
});
export const updateFcmTokenSchema = z.object({
    userId: z.string().trim().min(1, "userId is required"),
    token: z.string().trim().min(1, "token is required"),
});
export const checkInResponseSchema = z.object({
    userId: z.string().trim().min(1, "userId is required"),
    checkInId: z.string().trim().min(1, "checkInId is required"),
    response: z.string().trim().min(1, "response is required"),
});
//# sourceMappingURL=schemas.js.map