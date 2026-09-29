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

// ---- Services & reservations --------------------------------------------------------------

export const serviceInput = z.object({
  name: z.string().trim().min(1, "Service name is required").max(100),
  category: z.enum(["daycare", "boarding", "grooming", "training", "add_on", "other"]),
  description: optionalText(1000),
  priceCents: z.number().int("Price must be in whole cents").min(0, "Price can't be negative").max(100_000_000),
  priceUnit: z.enum(["per_day", "per_night", "per_visit"]),
  durationMinutes: z.number().int().positive().max(24 * 60).nullable().optional(),
  isActive: z.boolean().optional(),
  /** Whether sales tax applies to this service (at the location's rate). */
  isTaxable: z.boolean().optional(),
  /** Vaccines a pet of each species must have, valid through the stay. Replaces the whole set. */
  vaccineRequirements: z.object({
    dog: z.array(z.string().trim().min(1).max(100)).max(20),
    cat: z.array(z.string().trim().min(1).max(100)).max(20),
    other: z.array(z.string().trim().min(1).max(100)).max(20),
  }).partial().optional(),
});
export type ServiceInput = z.input<typeof serviceInput>;

const instant = z.iso.datetime({ offset: true, message: "Enter a valid date and time" });

export const reservationInput = z
  .object({
    customerId: z.uuid(),
    locationId: z.uuid(),
    serviceId: z.uuid(),
    petIds: z.array(z.uuid()).min(1, "Choose at least one pet").max(20)
      .refine((ids) => new Set(ids).size === ids.length, "A pet can only be added once"),
    startsAt: instant,
    endsAt: instant,
    notes: optionalText(5000),
    status: z.enum(["pending", "confirmed"]).default("pending"),
    /** Book even when a capacity limit is reached. Requires reservations:override_capacity. */
    overrideCapacity: z.boolean().optional(),
  })
  .refine((r) => new Date(r.endsAt) > new Date(r.startsAt), {
    message: "End must be after the start", path: ["endsAt"],
  });
export type ReservationInput = z.input<typeof reservationInput>;

/** Reschedule / edit. Customer, service and location are fixed once booked (cancel and rebook instead). */
export const reservationUpdateInput = z
  .object({
    petIds: z.array(z.uuid()).min(1, "Choose at least one pet").max(20)
      .refine((ids) => new Set(ids).size === ids.length, "A pet can only be added once").optional(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    notes: optionalText(5000),
    overrideCapacity: z.boolean().optional(),
  });

export const reservationStatusInput = z.object({
  status: z.enum(["pending", "confirmed", "checked_in", "completed", "cancelled", "no_show"]),
  /** Cancellation reason. */
  reason: optionalText(1000),
  /** Check in despite missing/expired vaccinations. Requires stays:override_vaccinations and a reason. */
  overrideVaccinations: z.boolean().optional(),
  overrideReason: optionalText(1000),
});

export const reservationListQuery = z.object({
  from: instant.optional(),
  to: instant.optional(),
  status: z.enum(["pending", "confirmed", "checked_in", "completed", "cancelled", "no_show"]).optional(),
  customerId: z.uuid().optional(),
  petId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const resourceInput = z.object({
  locationId: z.uuid(),
  name: z.string().trim().min(1, "Name is required").max(100),
  kind: z.enum(["kennel", "suite", "room", "run", "play_area", "grooming_station", "other"]),
  capacity: z.number().int().min(1, "Must hold at least 1 pet").max(100),
  notes: optionalText(1000),
  isActive: z.boolean().optional(),
});

export const capacityLimitsInput = z.object({
  /** null = no limit. */
  daycare: z.number().int().min(0).max(10_000).nullable(),
  boarding: z.number().int().min(0).max(10_000).nullable(),
});

export const assignmentsInput = z.object({
  assignments: z.array(z.object({ petId: z.uuid(), resourceId: z.uuid().nullable() })).min(1).max(20),
});

// ---- Care records -------------------------------------------------------------------------

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:00");

export const medicationInput = z.object({
  name: z.string().trim().min(1, "Medication name is required").max(200),
  dosage: z.string().trim().min(1, "Dosage is required").max(200),
  instructions: optionalText(2000),
  times: z.array(timeOfDay).max(12).default([]),
});

const careBase = {
  petId: z.uuid(),
  /** Defaults to now. Can be backdated (e.g. logging after the fact) but not in the future. */
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  notes: optionalText(2000),
};

export const careLogInput = z.discriminatedUnion("kind", [
  z.object({ ...careBase, kind: z.literal("feeding"), meal: z.enum(["breakfast", "lunch", "dinner", "snack"]), amountEaten: z.enum(["all", "most", "some", "none"]) }),
  z.object({
    ...careBase, kind: z.literal("medication"), medicationId: z.uuid(),
    status: z.enum(["given", "refused", "skipped"]),
    /** The scheduled dose this entry fulfils (from the due list); omit for as-needed doses. */
    scheduledFor: z.iso.datetime({ offset: true }).optional(),
  }),
  z.object({ ...careBase, kind: z.enum(["potty", "walk", "play", "rest", "grooming", "note"]) }),
]);
export type CareLogInput = z.input<typeof careLogInput>;

export const voidInput = z.object({
  reason: z.string().trim().min(1, "Give a reason").max(1000),
});

export const incidentInput = z.object({
  petId: z.uuid(),
  reservationId: z.uuid().nullable().optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  category: z.enum(["injury", "illness", "behavior", "altercation", "escape", "property", "other"]),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string().trim().min(1, "Describe what happened").max(5000),
  actionsTaken: optionalText(5000),
  ownerNotified: z.boolean().default(false),
  followUpRequired: z.boolean().default(false),
});

/** Follow-up and resolution; the original description can't be changed. */
export const incidentUpdateInput = z.object({
  actionsTaken: optionalText(5000),
  ownerNotified: z.boolean().optional(),
  followUpRequired: z.boolean().optional(),
  followUpNotes: optionalText(5000),
  resolution: z.string().trim().min(1).max(5000).optional(),
});

// ---- Billing -------------------------------------------------------------------------------

export const taxRateInput = z.object({
  taxRateBps: z.number().int().min(0, "Tax rate can't be negative").max(10_000, "Tax rate can't be over 100%"),
});

const cents = z.number().int("Amounts are in whole cents");

export const invoiceLineInput = z.object({
  /** Optional: fills description, price and taxable from the service. */
  serviceId: z.uuid().optional(),
  description: z.string().trim().min(1, "Description is required").max(300).optional(),
  quantity: z.number().int().min(1, "Quantity must be at least 1").max(1000),
  unitPriceCents: cents.min(0, "Price can't be negative").max(100_000_000).optional(),
  discountCents: cents.min(0, "Discount can't be negative").default(0),
  taxable: z.boolean().optional(),
});

export const invoiceCreateInput = z.object({
  customerId: z.uuid(),
  locationId: z.uuid(),
  notes: optionalText(2000),
});

export const invoiceVoidInput = z.object({ reason: z.string().trim().min(1, "Give a reason for voiding").max(1000) });

export const paymentInput = z.object({
  amountCents: cents.min(1, "Enter an amount greater than zero").max(100_000_000),
  method: z.enum(["card", "cash", "check", "other"]),
  reference: optionalText(200),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
});

const reason = z.string().trim().min(1, "Give a reason").max(1000);
const positiveCents = z.number().int("Amounts are in whole cents").min(1, "Enter an amount greater than zero").max(100_000_000);
const moneyMethod = z.enum(["card", "cash", "check", "other"]);

export const creditNoteInput = z.object({ amountCents: positiveCents, reason });

/** Refund an invoice overpayment: back to the customer, or onto their account credit. */
export const invoiceRefundInput = z.object({
  amountCents: positiveCents,
  method: z.enum(["card", "cash", "check", "other", "account_credit"]),
  reference: optionalText(200),
  reason,
});

/** Money taken on account (deposit or prepayment). */
export const creditReceiveInput = z.object({
  amountCents: positiveCents,
  method: moneyMethod,
  reference: optionalText(200),
  note: optionalText(500),
  reservationId: z.uuid().optional(),
});

export const creditApplyInput = z.object({ amountCents: positiveCents });

/** Pay account credit back out to the customer. */
export const creditRefundInput = z.object({ amountCents: positiveCents, method: moneyMethod, reference: optionalText(200), reason });

// ---- Staff ---------------------------------------------------------------------------------

const role = z.enum(["owner", "administrator", "general_manager", "location_manager", "manager", "shift_lead", "front_desk", "groomer", "care_attendant", "employee"]);
const newPassword = z.string().min(10, "Use at least 10 characters").max(200);

export const employeeCreateInput = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().min(1, "Last name is required").max(100),
  email: z.email("Enter a valid email address").max(254).transform((v) => v.toLowerCase()),
  phone: optionalText(40),
  role,
  jobTitle: optionalText(100),
  locationIds: z.array(z.uuid()).max(50).default([]),
  temporaryPassword: newPassword,
});

export const employeeUpdateInput = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  phone: optionalText(40),
  role: role.optional(),
  jobTitle: optionalText(100),
  locationIds: z.array(z.uuid()).max(50).optional(),
});

export const passwordResetInput = z.object({ temporaryPassword: newPassword });

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword,
});

// ---- Reports -------------------------------------------------------------------------------

/** Inclusive local-date range, at most about a year. */
export const reportRangeQuery = z.object({
  from: isoDate,
  to: isoDate,
}).refine((r) => r.from <= r.to, { message: "The start date must be on or before the end date", path: ["to"] })
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 366, { message: "Choose a range of a year or less", path: ["to"] });
