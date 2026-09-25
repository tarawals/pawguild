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
  daycareCapacity: number | null;
  isActive: Generated<boolean>;
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
}

export interface ReservationPetsTable {
  organizationId: string;
  reservationId: string;
  customerId: string;
  petId: string;
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
}

export type Customer = Selectable<CustomersTable>;
export type NewCustomer = Insertable<CustomersTable>;
export type CustomerUpdate = Updateable<CustomersTable>;
export type Pet = Selectable<PetsTable>;
