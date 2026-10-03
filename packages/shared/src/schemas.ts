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
    /** Book drop-off or pick-up outside business hours or on a closed day. Requires reservations:override_hours. */
    overrideHours: z.boolean().optional(),
    /** Grooming appointments only: the staff member doing the grooming. */
    groomerMembershipId: z.uuid().nullable().optional(),
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
    overrideHours: z.boolean().optional(),
    /** null unassigns the groomer. */
    groomerMembershipId: z.uuid().nullable().optional(),
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

/** True for an IANA time zone name this runtime knows, e.g. "America/New_York". */
export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz.includes("/") || tz === "UTC"; } catch { return false; }
}

const locationFields = {
  name: z.string().trim().min(1, "Location name is required").max(100),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  country: z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/, "Use a two-letter country code, like US")
    .transform((v) => (v === "" ? null : v)).nullable().optional(),
  phone: optionalText(40),
  email: z.union([z.literal(""), z.email("Enter a valid email address").max(254)])
    .transform((v) => (v === "" ? null : v.toLowerCase())).nullable().optional(),
  /** null = use the organization's time zone. */
  timezone: z.string().trim().max(64)
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || isValidTimeZone(v), "Choose a time zone from the list")
    .nullable().optional(),
};
export const locationInput = z.object(locationFields);
export const locationUpdateInput = z.object({ ...locationFields, name: locationFields.name.optional(), isActive: z.boolean().optional() });

export const locationHoursInput = z.object({
  /** One entry per open weekday (0 = Sunday). Days left out are closed. An empty list removes the hours restriction. */
  days: z.array(z.object({ weekday: z.number().int().min(0).max(6), opensAt: timeOfDay, closesAt: timeOfDay })).max(7),
}).superRefine((v, ctx) => {
  const seen = new Set<number>();
  v.days.forEach((d, i) => {
    if (seen.has(d.weekday)) ctx.addIssue({ code: "custom", path: ["days", i, "weekday"], message: "Each day can only be listed once" });
    seen.add(d.weekday);
    if (d.closesAt <= d.opensAt) ctx.addIssue({ code: "custom", path: ["days", i, "closesAt"], message: "Closing time must be after opening time" });
  });
});

export const locationClosureInput = z.object({
  closedOn: isoDate,
  reason: optionalText(200),
});

export const groomingScheduleQuery = z.object({
  date: isoDate,
  locationId: z.uuid().optional(),
});

const shiftFields = {
  locationId: z.uuid(),
  membershipId: z.uuid(),
  startsAt: instant,
  endsAt: instant,
  note: optionalText(300),
};
const shiftLength = (s: { startsAt?: string; endsAt?: string }, ctx: z.RefinementCtx) => {
  if (!s.startsAt || !s.endsAt) return;
  const ms = Date.parse(s.endsAt) - Date.parse(s.startsAt);
  if (ms <= 0) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The shift must end after it starts" });
  else if (ms > 16 * 3_600_000) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "A shift can be at most 16 hours" });
};
export const shiftInput = z.object(shiftFields).superRefine(shiftLength);
export const shiftUpdateInput = z.object({
  locationId: shiftFields.locationId.optional(),
  membershipId: shiftFields.membershipId.optional(),
  startsAt: instant.optional(),
  endsAt: instant.optional(),
  note: shiftFields.note,
});
export const shiftListQuery = z.object({
  from: isoDate, to: isoDate, locationId: z.uuid().optional(), membershipId: z.uuid().optional(),
})
  .refine((r) => r.from <= r.to, { message: "The start date must be on or before the end date", path: ["to"] })
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 42, { message: "Choose six weeks or less", path: ["to"] });
export const copyWeekInput = z.object({
  locationId: z.uuid(),
  /** First day of the week to copy (any weekday; seven days from here are copied). */
  fromWeekStart: isoDate,
  toWeekStart: isoDate,
}).refine((r) => r.fromWeekStart !== r.toWeekStart, { message: "Choose a different week to copy to", path: ["toWeekStart"] });

export const organizationSettingsInput = z.object({
  name: z.string().trim().min(1, "Business name is required").max(120),
  email: z.union([z.literal(""), z.email("Enter a valid email address").max(254)])
    .transform((v) => (v === "" ? null : v.toLowerCase())).nullable().optional(),
  phone: optionalText(40),
  timezone: z.string().trim().refine(isValidTimeZone, "Choose a time zone from the list"),
});

export const MAX_SERIES_OCCURRENCES = 100;
export const reservationSeriesInput = z.object({
  customerId: z.uuid(),
  locationId: z.uuid(),
  serviceId: z.uuid(),
  petIds: z.array(z.uuid()).min(1, "Choose at least one pet").max(20)
    .refine((ids) => new Set(ids).size === ids.length, "A pet can only be added once"),
  /** 0 = Sunday. */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, "Choose at least one day")
    .refine((d) => new Set(d).size === d.length, "Each day can only be chosen once"),
  startTime: timeOfDay,
  endTime: timeOfDay,
  firstDate: isoDate,
  lastDate: isoDate,
  notes: optionalText(5000),
  status: z.enum(["pending", "confirmed"]).default("confirmed"),
  groomerMembershipId: z.uuid().nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.endTime <= v.startTime) ctx.addIssue({ code: "custom", path: ["endTime"], message: "Pick-up must be after drop-off on the same day" });
  if (v.lastDate < v.firstDate) ctx.addIssue({ code: "custom", path: ["lastDate"], message: "The last date must be on or after the first" });
  else if ((Date.parse(v.lastDate) - Date.parse(v.firstDate)) / 86_400_000 > 183) {
    ctx.addIssue({ code: "custom", path: ["lastDate"], message: "A series can run for up to six months" });
  }
});
export type ReservationSeriesInput = z.input<typeof reservationSeriesInput>;

export const seriesCancelInput = z.object({
  /** Cancel occurrences on or after this local date. */
  fromDate: isoDate,
  reason: z.string().trim().min(1, "Give a reason for cancelling").max(1000),
});

export const billingRulesInput = z.object({
  boardingMode: z.enum(["nights", "nights_plus_daycare", "per_24_hours"]),
  boardingExtraTime: z.enum(["extra_night", "daycare"]),
  halfDayMaxHours: z.number().min(1, "At least 1 hour").max(12, "At most 12 hours")
    .refine((h) => Number.isInteger(h * 4), "Use quarter hours, like 4.5"),
  gracePeriodMinutes: z.number().int("Whole minutes").min(0).max(180, "At most 180 minutes"),
  daytimeStart: timeOfDay,
  daytimeEnd: timeOfDay,
  daycareFullServiceId: z.uuid().nullable(),
  daycareHalfServiceId: z.uuid().nullable(),
  additionalPetDiscountBps: z.number().int().min(0).max(10_000, "At most 100%"),
}).superRefine((v, ctx) => {
  if (v.daytimeEnd <= v.daytimeStart) ctx.addIssue({ code: "custom", path: ["daytimeEnd"], message: "Daytime must end after it starts" });
  if (v.daycareFullServiceId && v.daycareFullServiceId === v.daycareHalfServiceId) {
    ctx.addIssue({ code: "custom", path: ["daycareHalfServiceId"], message: "Choose a different service for half days" });
  }
  const needsDaycare = v.boardingMode === "nights_plus_daycare" || (v.boardingMode === "per_24_hours" && v.boardingExtraTime === "daycare");
  if (needsDaycare && !v.daycareFullServiceId) {
    ctx.addIssue({ code: "custom", path: ["daycareFullServiceId"], message: "Choose the full-day daycare service, so daycare during boarding can be charged" });
  }
});
export type BillingRulesInput = z.input<typeof billingRulesInput>;

export const PACKAGE_COVERS = ["full_day", "half_day"] as const;
export type PackageCovers = (typeof PACKAGE_COVERS)[number];
export const PACKAGE_COVERS_LABELS: Record<PackageCovers, string> = { full_day: "Full days of daycare", half_day: "Half days of daycare" };

export const packageProductInput = z.object({
  name: z.string().trim().min(1, "Package name is required").max(100),
  covers: z.enum(PACKAGE_COVERS),
  days: z.number().int("Whole days").min(1, "At least 1 day").max(500, "At most 500 days"),
  priceCents: z.number().int("Amounts are in whole cents").min(0, "Price can't be negative").max(100_000_000),
  /** null = never expires. */
  expiresAfterDays: z.number().int("Whole days").min(1, "At least 1 day").max(3650, "At most 10 years").nullable(),
  isTaxable: z.boolean().default(false),
  isActive: z.boolean().optional(),
});
export const packageProductUpdateInput = packageProductInput.partial();
export const sellPackageInput = z.object({
  productId: z.uuid(),
  /** Where the sale is invoiced; defaults to the first active location. */
  locationId: z.uuid().optional(),
});

export const membershipPlanInput = z.object({
  name: z.string().trim().min(1, "Plan name is required").max(100),
  covers: z.enum(PACKAGE_COVERS),
  daysPerMonth: z.number().int("Whole days").min(1, "At least 1 day").max(31, "At most 31 days"),
  priceCents: z.number().int("Amounts are in whole cents").min(0, "Price can't be negative").max(100_000_000),
  isTaxable: z.boolean().default(false),
  isActive: z.boolean().optional(),
});
export const membershipPlanUpdateInput = membershipPlanInput.partial();
export const membershipSignupInput = z.object({
  planId: z.uuid(),
  /** The first billing date; defaults to today. Later months bill on the same day. */
  startsOn: isoDate.optional(),
  locationId: z.uuid().optional(),
});
export const membershipCancelInput = z.object({ reason: optionalText(500) });
