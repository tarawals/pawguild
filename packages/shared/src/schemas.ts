/** Input validation schemas shared by the API (authoritative) and the web app (early feedback). */
import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD");

export const CUSTOMER_STATUSES = ["active", "inactive", "banned"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const customerInput = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().min(1, "Last name is required").max(100),
  email: z
    .union([z.literal(""), z.email("Enter a valid email address").max(254)])
    .transform((v) => (v === "" ? null : v.toLowerCase()))
    .nullable()
    .optional(),
  phone: optionalText(40),
  altPhone: optionalText(40),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  country: optionalText(2),
  emergencyContactName: optionalText(200),
  emergencyContactPhone: optionalText(40),
  notes: optionalText(5000),
  status: z.enum(CUSTOMER_STATUSES).optional(),
  emailOptIn: z.boolean().optional(),
  smsOptIn: z.boolean().optional(),
});
export type CustomerInput = z.input<typeof customerInput>;

export const SPECIES = ["dog", "cat", "other"] as const;
export const PET_SEXES = ["male", "female", "unknown"] as const;
export const PET_STATUSES = ["active", "inactive", "deceased"] as const;
export type PetStatus = (typeof PET_STATUSES)[number];

export const petInput = z.object({
  customerId: z.uuid(),
  name: z.string().trim().min(1, "Pet name is required").max(100),
  species: z.enum(SPECIES),
  breed: optionalText(100),
  sex: z.enum(PET_SEXES).default("unknown"),
  isFixed: z.boolean().nullable().optional(),
  dateOfBirth: isoDate.nullable().optional(),
  dateOfBirthIsEstimate: z.boolean().optional(),
  /** Weight in grams (integer). The UI converts from the organization's display unit. */
  weightGrams: z.number().int().positive().max(200_000).nullable().optional(),
  color: optionalText(100),
  temperament: optionalText(500),
  behaviorNotes: optionalText(5000),
  medicalNotes: optionalText(5000),
  allergies: optionalText(2000),
  feedingInstructions: optionalText(5000),
  specialInstructions: optionalText(5000),
  veterinarianName: optionalText(200),
  veterinarianPhone: optionalText(40),
  status: z.enum(PET_STATUSES).optional(),
});
export type PetInput = z.input<typeof petInput>;

export const petUpdateInput = petInput.omit({ customerId: true }).partial();

export const vaccinationInput = z
  .object({
    vaccine: z.string().trim().min(1, "Vaccine name is required").max(100),
    administeredOn: isoDate.nullable().optional(),
    expiresOn: isoDate,
    notes: optionalText(1000),
  })
  .refine((v) => !v.administeredOn || v.administeredOn <= v.expiresOn, {
    message: "Expiration date must be on or after the administered date",
    path: ["expiresOn"],
  });

export const loginInput = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
});

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  includeArchived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
