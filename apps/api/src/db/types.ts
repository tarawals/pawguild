/**
 * Kysely table types (camelCase via CamelCasePlugin). Keep in sync with migrations/.
 * See docs/DATABASE.md for the conceptual model.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, never, never>;
/** DATE columns are returned as 'YYYY-MM-DD' strings (see db/index.ts type parser). */
type DateString = string;

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  timezone: Generated<string>;
  currency: Generated<string>;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface LocationsTable {
  id: Generated<string>;
  organizationId: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  timezone: string | null;
  isActive: Generated<boolean>;
  taxRateBps: Generated<number>;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: Generated<boolean>;
  lastLoginAt: Date | null;
  mustChangePassword: Generated<boolean>;
  passwordChangedAt: Date | null;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface MembershipsTable {
  id: Generated<string>;
  organizationId: string;
  userId: string;
  role: string;
  jobTitle: string | null;
  isActive: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface MembershipLocationsTable {
  organizationId: string;
  membershipId: string;
  locationId: string;
}

export interface SessionsTable {
  id: Generated<string>;
  tokenHash: string;
  userId: string;
  organizationId: string;
  createdAt: CreatedAt;
  expiresAt: Timestamp;
  revokedAt: Date | null;
}

export interface CustomersTable {
  id: Generated<string>;
  organizationId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  altPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  notes: string | null;
  status: Generated<string>;
  emailOptIn: Generated<boolean>;
  smsOptIn: Generated<boolean>;
  archivedAt: Date | null;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface PetsTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  name: string;
  species: string;
  breed: string | null;
  sex: Generated<string>;
  isFixed: boolean | null;
  dateOfBirth: DateString | null;
  dateOfBirthIsEstimate: Generated<boolean>;
  weightGrams: number | null;
  color: string | null;
  temperament: string | null;
  behaviorNotes: string | null;
  medicalNotes: string | null;
  allergies: string | null;
  feedingInstructions: string | null;
  specialInstructions: string | null;
  veterinarianName: string | null;
  veterinarianPhone: string | null;
  status: Generated<string>;
  archivedAt: Date | null;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface PetVaccinationsTable {
  id: Generated<string>;
  organizationId: string;
  petId: string;
  vaccine: string;
  administeredOn: DateString | null;
  expiresOn: DateString;
  notes: string | null;
  recordedByUserId: string;
  createdAt: CreatedAt;
  voidedAt: Date | null;
  voidedByUserId: string | null;
}

export interface AuditLogTable {
  id: Generated<number>;
  organizationId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: unknown;
  createdAt: CreatedAt;
}

export interface ServicesTable {
  id: Generated<string>;
  organizationId: string;
  name: string;
  category: string;
  description: string | null;
  priceCents: number;
  priceUnit: string;
  durationMinutes: number | null;
  isActive: Generated<boolean>;
  isTaxable: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface ReservationsTable {
  id: Generated<string>;
  organizationId: string;
  locationId: string;
  customerId: string;
  serviceId: string;
  status: Generated<string>;
  startsAt: Timestamp;
  endsAt: Timestamp;
  unitPriceCents: number;
  priceUnit: string;
  notes: string | null;
  createdByUserId: string;
  confirmedAt: Date | null;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
  groomerMembershipId: string | null;
  seriesId: string | null;
}

export interface ReservationPetsTable {
  organizationId: string;
  reservationId: string;
  customerId: string;
  petId: string;
  resourceId: string | null;
}

export interface LocationHoursTable {
  id: Generated<string>;
  organizationId: string;
  locationId: string;
  weekday: number;
  /** TIME columns are returned as 'HH:MM:SS' strings. */
  opensAt: string;
  closesAt: string;
}

export interface LocationClosuresTable {
  id: Generated<string>;
  organizationId: string;
  locationId: string;
  closedOn: DateString;
  reason: string | null;
}

export interface ShiftsTable {
  id: Generated<string>;
  organizationId: string;
  locationId: string;
  membershipId: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  note: string | null;
  createdByUserId: string;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface ReservationSeriesTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  locationId: string;
  serviceId: string;
  weekdays: number[];
  /** TIME columns are returned as 'HH:MM:SS' strings. */
  startTime: string;
  endTime: string;
  firstDate: DateString;
  lastDate: DateString;
  notes: string | null;
  createdByUserId: string;
  createdAt: CreatedAt;
}

export interface BillingSettingsTable {
  organizationId: string;
  boardingMode: Generated<string>;
  boardingExtraTime: Generated<string>;
  halfDayMaxMinutes: Generated<number>;
  gracePeriodMinutes: Generated<number>;
  daytimeStart: Generated<string>;
  daytimeEnd: Generated<string>;
  daycareFullServiceId: string | null;
  daycareHalfServiceId: string | null;
  additionalPetDiscountBps: Generated<number>;
  updatedAt: Generated<Date>;
}

export interface PackageProductsTable {
  id: Generated<string>;
  organizationId: string;
  name: string;
  covers: string;
  days: number;
  priceCents: number;
  expiresAfterDays: number | null;
  isTaxable: Generated<boolean>;
  isActive: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface CustomerPackagesTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  productId: string;
  name: string;
  covers: string;
  days: number;
  priceCents: number;
  purchasedAt: Generated<Date>;
  expiresOn: DateString | null;
  invoiceId: string;
  soldByUserId: string;
}

export interface PackageRedemptionsTable {
  id: Generated<string>;
  organizationId: string;
  customerPackageId: string | null;
  membershipPeriodId: string | null;
  invoiceId: string;
  invoiceLineId: string;
  reservationId: string | null;
  usedOn: DateString;
  createdAt: CreatedAt;
}

export interface MembershipPlansTable {
  id: Generated<string>;
  organizationId: string;
  name: string;
  covers: string;
  daysPerMonth: number;
  priceCents: number;
  isTaxable: Generated<boolean>;
  isActive: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface CustomerMembershipsTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  planId: string;
  locationId: string;
  name: string;
  covers: string;
  daysPerMonth: number;
  priceCents: number;
  isTaxable: boolean;
  startedOn: DateString;
  endsOn: DateString | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  cancelReason: string | null;
  createdByUserId: string;
  createdAt: CreatedAt;
}

export interface MembershipPeriodsTable {
  id: Generated<string>;
  organizationId: string;
  customerMembershipId: string;
  periodStart: DateString;
  periodEnd: DateString;
  days: number;
  invoiceId: string;
  createdAt: CreatedAt;
}

export interface LocationCapacitiesTable {
  organizationId: string;
  locationId: string;
  category: string;
  maxPets: number;
  updatedAt: Generated<Date>;
}

export interface ResourcesTable {
  id: Generated<string>;
  organizationId: string;
  locationId: string;
  name: string;
  kind: string;
  capacity: Generated<number>;
  notes: string | null;
  isActive: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
}

export interface ServiceVaccineRequirementsTable {
  organizationId: string;
  serviceId: string;
  species: string;
  vaccine: string;
}

export interface PetMedicationsTable {
  id: Generated<string>;
  organizationId: string;
  petId: string;
  name: string;
  dosage: string;
  instructions: string | null;
  /** time[]; select as text[] (see routes/medications.ts). */
  times: ColumnType<string[], string[] | undefined, never>;
  createdByUserId: string;
  createdAt: CreatedAt;
  discontinuedAt: Date | null;
  discontinuedByUserId: string | null;
}

export interface CareLogsTable {
  id: Generated<string>;
  organizationId: string;
  reservationId: string;
  petId: string;
  kind: string;
  occurredAt: Timestamp;
  notes: string | null;
  meal: string | null;
  amountEaten: string | null;
  petMedicationId: string | null;
  medicationName: string | null;
  dose: string | null;
  medicationStatus: string | null;
  scheduledFor: Timestamp | null;
  recordedByUserId: string;
  createdAt: CreatedAt;
  voidedAt: Date | null;
  voidedByUserId: string | null;
  voidReason: string | null;
}

export interface IncidentsTable {
  id: Generated<string>;
  organizationId: string;
  petId: string;
  reservationId: string | null;
  occurredAt: Timestamp;
  category: string;
  severity: string;
  description: string;
  actionsTaken: string | null;
  ownerNotified: Generated<boolean>;
  followUpRequired: Generated<boolean>;
  followUpNotes: string | null;
  reportedByUserId: string;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolution: string | null;
}

export interface InvoiceCountersTable {
  organizationId: string;
  lastNumber: Generated<number>;
}

export interface InvoicesTable {
  id: Generated<string>;
  organizationId: string;
  locationId: string;
  customerId: string;
  reservationId: string | null;
  status: Generated<string>;
  number: number | null;
  taxRateBps: number;
  subtotalCents: number | null;
  discountCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: CreatedAt;
  updatedAt: Generated<Date>;
  issuedAt: Date | null;
  issuedByUserId: string | null;
  voidedAt: Date | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  usePackages: Generated<boolean>;
}

export interface InvoiceLinesTable {
  id: Generated<string>;
  organizationId: string;
  invoiceId: string;
  serviceId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: Generated<number>;
  taxable: boolean;
  position: Generated<number>;
  createdAt: CreatedAt;
  stayLine: Generated<boolean>;
}

export interface PaymentsTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  invoiceId: string;
  amountCents: number;
  method: string;
  reference: string | null;
  receivedAt: Timestamp;
  recordedByUserId: string;
  createdAt: CreatedAt;
  voidedAt: Date | null;
  voidedByUserId: string | null;
  voidReason: string | null;
}

export interface InvoiceCreditNotesTable {
  id: Generated<string>;
  organizationId: string;
  invoiceId: string;
  customerId: string;
  amountCents: number;
  reason: string;
  createdByUserId: string;
  createdAt: CreatedAt;
}

export interface RefundsTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  invoiceId: string | null;
  amountCents: number;
  method: string;
  reference: string | null;
  reason: string;
  refundedAt: Timestamp;
  recordedByUserId: string;
  createdAt: CreatedAt;
}

export interface AccountCreditsTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  amountCents: number;
  kind: string;
  method: string | null;
  reference: string | null;
  note: string | null;
  reservationId: string | null;
  invoiceId: string | null;
  paymentId: string | null;
  refundId: string | null;
  createdByUserId: string;
  createdAt: CreatedAt;
}

export interface LoginAttemptsTable {
  id: Generated<number>;
  email: string;
  ip: string;
  succeeded: boolean;
  attemptedAt: Generated<Date>;
}

export interface Database {
  organizations: OrganizationsTable;
  locations: LocationsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  membershipLocations: MembershipLocationsTable;
  sessions: SessionsTable;
  customers: CustomersTable;
  pets: PetsTable;
  petVaccinations: PetVaccinationsTable;
  auditLog: AuditLogTable;
  services: ServicesTable;
  reservations: ReservationsTable;
  reservationPets: ReservationPetsTable;
  locationCapacities: LocationCapacitiesTable;
  locationHours: LocationHoursTable;
  shifts: ShiftsTable;
  reservationSeries: ReservationSeriesTable;
  billingSettings: BillingSettingsTable;
  packageProducts: PackageProductsTable;
  customerPackages: CustomerPackagesTable;
  packageRedemptions: PackageRedemptionsTable;
  membershipPlans: MembershipPlansTable;
  customerMemberships: CustomerMembershipsTable;
  membershipPeriods: MembershipPeriodsTable;
  locationClosures: LocationClosuresTable;
  resources: ResourcesTable;
  serviceVaccineRequirements: ServiceVaccineRequirementsTable;
  petMedications: PetMedicationsTable;
  careLogs: CareLogsTable;
  incidents: IncidentsTable;
  invoiceCounters: InvoiceCountersTable;
  invoices: InvoicesTable;
  invoiceLines: InvoiceLinesTable;
  payments: PaymentsTable;
  invoiceCreditNotes: InvoiceCreditNotesTable;
  refunds: RefundsTable;
  accountCredits: AccountCreditsTable;
  loginAttempts: LoginAttemptsTable;
}

export type Customer = Selectable<CustomersTable>;
export type NewCustomer = Insertable<CustomersTable>;
export type CustomerUpdate = Updateable<CustomersTable>;
export type Pet = Selectable<PetsTable>;
