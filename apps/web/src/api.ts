/** Thin client for the PawGuild API. All requests are same-origin and cookie-authenticated. */

export interface FieldError { path: string; message: string }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldError[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
  fieldMessage(path: string): string | undefined {
    return this.fields.find((f) => f.path === path)?.message;
  }
}

export async function api<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" ? { "x-pawguild-request": "1" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : method === "POST" || method === "PATCH" || method === "PUT" ? "{}" : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach PawGuild. Check your internet connection and try again.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "unknown",
      err?.message ?? "Something went wrong. Please try again.",
      err?.fields ?? [],
    );
  }
  return data as T;
}

export const get = <T,>(url: string) => api<T>("GET", url);
export const post = <T,>(url: string, body?: unknown) => api<T>("POST", url, body ?? {});
export const patch = <T,>(url: string, body: unknown) => api<T>("PATCH", url, body);
export const put = <T,>(url: string, body: unknown) => api<T>("PUT", url, body);
export const del = <T,>(url: string) => api<T>("DELETE", url);

// ---- Response types (mirror the API) --------------------------------------------------------

export interface Me {
  user: { id: string; email: string; firstName: string; lastName: string; mustChangePassword: boolean };
  organization: { id: string; name: string; timezone: string; currency: string };
  role: string;
  roleLabel: string;
  membershipId: string;
  permissions: string[];
}

export interface CustomerListItem {
  id: string; firstName: string; lastName: string; email: string | null; phone: string | null;
  status: string; archivedAt: string | null; petNames: string[];
}

export interface Customer {
  id: string; firstName: string; lastName: string; email: string | null; phone: string | null;
  altPhone: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null;
  region: string | null; postalCode: string | null; country: string | null;
  emergencyContactName: string | null; emergencyContactPhone: string | null; notes: string | null;
  status: string; emailOptIn: boolean; smsOptIn: boolean; archivedAt: string | null;
  createdAt: string; updatedAt: string;
  pets?: { id: string; name: string; species: string; breed: string | null; status: string; archivedAt: string | null }[];
  /** Billing summary; null when the user can't see billing. */
  billing?: { owedCents: number; overpaidCents: number; creditCents: number } | null;
}

export interface Pet {
  id: string; customerId: string; name: string; species: string; breed: string | null; sex: string;
  isFixed: boolean | null; dateOfBirth: string | null; dateOfBirthIsEstimate: boolean;
  weightGrams: number | null; color: string | null; temperament: string | null;
  behaviorNotes: string | null; medicalNotes: string | null; allergies: string | null;
  feedingInstructions: string | null; specialInstructions: string | null;
  veterinarianName: string | null; veterinarianPhone: string | null; status: string;
  archivedAt: string | null;
  owner?: { id: string; firstName: string; lastName: string; phone: string | null; email: string | null;
    emergencyContactName: string | null; emergencyContactPhone: string | null };
  vaccinations?: { id: string; vaccine: string; administeredOn: string | null; expiresOn: string; notes: string | null }[];
}

export interface AuditEntry {
  id: number; action: string; entityType: string; entityId: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null; createdAt: string; actorName: string | null;
}

export interface Service {
  id: string; name: string; category: string; description: string | null; priceCents: number;
  priceUnit: string; durationMinutes: number | null; isActive: boolean; isTaxable: boolean;
  vaccineRequirements: { dog: string[]; cat: string[]; other: string[] };
}

export interface Location {
  id: string; name: string; timezone: string | null; effectiveTimezone: string; isActive: boolean; taxRateBps: number;
  addressLine1: string | null; addressLine2: string | null; city: string | null; region: string | null; postalCode: string | null;
  country: string | null; phone: string | null; email: string | null;
  capacity: { daycare: number | null; boarding: number | null };
  hours: { weekday: number; opensAt: string; closesAt: string }[];
  /** Upcoming closures (today onward). */
  closures: { id: string; closedOn: string; reason: string | null }[];
}

export interface Resource {
  id: string; locationId: string; name: string; kind: string; capacity: number; notes: string | null; isActive: boolean;
}

export interface ResourceAvailability { id: string; name: string; kind: string; capacity: number; occupied: number; available: number }

export interface Occupancy { period: string; booked: number; limit: number | null }

export interface ReservationListItem {
  id: string; status: string; startsAt: string; endsAt: string; customerId: string; customerName: string;
  serviceName: string; serviceCategory?: string; locationName?: string; petNames: string[];
  /** Dashboard arrivals only: pets that would fail check-in vaccination verification. */
  petsNeedingVaccinations?: string[];
}

export interface Reservation {
  id: string; status: string; startsAt: string; endsAt: string; notes: string | null;
  unitPriceCents: number; priceUnit: string; confirmedAt: string | null; checkedInAt: string | null;
  checkedOutAt: string | null; cancelledAt: string | null; cancellationReason: string | null; createdAt: string;
  customer: { id: string; firstName: string; lastName: string; phone: string | null };
  service: { id: string; name: string; category: string };
  location: { id: string; name: string };
  groomer: { membershipId: string; name: string } | null;
  pets: {
    id: string; name: string; species: string; breed: string | null; allergies: string | null; medicalNotes: string | null;
    resourceId: string | null; resourceName: string | null;
  }[];
  invoice: { id: string; status: string; number: number | null } | null;
  depositsCents: number;
  vaccinationCheck: {
    petId: string; petName: string; ok: boolean;
    checks: { vaccine: string; state: "current" | "missing" | "expired" | "expires_during_stay"; expiresOn: string | null }[];
  }[];
  allowedTransitions: string[];
  estimate: { quantity: number; petCount: number; unitPriceCents: number; totalCents: number };
}

export interface DashboardSummary {
  activeCustomers: number;
  activePets: number;
  petsCheckedIn: number;
  outstanding: { cents: number; invoices: number; overpaidInvoices: number } | null;
  medicationDue: Dose[];
  openIncidents: { id: string; petId: string; petName: string; category: string; severity: string; occurredAt: string; reservationId: string | null; followUpRequired: boolean }[];
  occupancy: { locationId: string; locationName: string; daycare: Occupancy; boarding: Occupancy }[];
  arrivals: ReservationListItem[];
  departures: ReservationListItem[];
  vaccinationAlerts: { petId: string; petName: string; vaccine: string; expiresOn: string; customerName: string }[];
}

// ---- Care ----------------------------------------------------------------------------------

export interface Medication {
  id: string; name: string; dosage: string; instructions: string | null; times: string[];
  createdAt: string; discontinuedAt: string | null;
}

export interface Dose {
  reservationId: string; petId: string; petName: string; medicationId: string; medicationName: string;
  dosage: string; scheduledFor: string; status: "due" | "overdue" | "given" | "refused" | "skipped"; careLogId: string | null;
}

export interface CarePet {
  id: string; name: string; species: string; breed: string | null; allergies: string | null; medicalNotes: string | null;
  feedingInstructions: string | null; specialInstructions: string | null; behaviorNotes: string | null; kennel: string | null;
  medications: Medication[]; doses: Dose[]; lastCare: Record<string, string>; openIncidents: number;
}

export interface CareStay {
  id: string; startsAt: string; endsAt: string; checkedInAt: string | null; serviceName: string;
  customerName: string; customerPhone: string | null; pets: CarePet[];
}

export interface CareLogEntry {
  id: string; kind: string; occurredAt: string; notes: string | null; meal: string | null; amountEaten: string | null;
  medicationName: string | null; dose: string | null; medicationStatus: string | null; scheduledFor: string | null;
  createdAt: string; voidedAt: string | null; voidReason: string | null; petId: string; petName: string;
  recordedBy: string; voidedBy: string | null;
}

export interface Incident {
  id: string; petId: string; petName: string; reservationId: string | null; occurredAt: string; category: string;
  severity: "low" | "medium" | "high"; description: string; actionsTaken: string | null; ownerNotified: boolean;
  followUpRequired: boolean; followUpNotes: string | null; createdAt: string; updatedAt: string;
  resolvedAt: string | null; resolution: string | null; reportedBy: string; resolvedBy: string | null;
}

// ---- Billing -------------------------------------------------------------------------------

export interface InvoiceListItem {
  id: string; number: number | null; status: "draft" | "issued" | "void"; createdAt: string; issuedAt: string | null;
  customerId: string; customerName: string; reservationId: string | null; totalCents: number; paidCents: number; balanceCents: number;
}

export interface InvoiceLine {
  id: string; serviceId: string | null; description: string; quantity: number; unitPriceCents: number;
  discountCents: number; taxable: boolean; amountCents: number;
}

export interface Payment {
  id: string; amountCents: number; method: string; reference: string | null; receivedAt: string;
  voidedAt: string | null; voidReason: string | null; recordedBy: string;
}

export interface Invoice {
  id: string; status: "draft" | "issued" | "void"; number: number | null; taxRateBps: number; notes: string | null;
  reservationId: string | null; createdAt: string; issuedAt: string | null; voidedAt: string | null; voidReason: string | null;
  customer: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null };
  location: { id: string; name: string };
  lines: InvoiceLine[]; payments: Payment[];
  creditNotes: { id: string; amountCents: number; reason: string; createdAt: string; createdBy: string }[];
  refunds: { id: string; amountCents: number; method: string; reference: string | null; reason: string; refundedAt: string; recordedBy: string }[];
  totals: { subtotalCents: number; discountCents: number; taxableCents: number; taxCents: number; totalCents: number };
  creditNotesCents: number; refundsCents: number; paidCents: number; balanceCents: number; customerCreditCents: number;
  paymentStatus: "draft" | "void" | "unpaid" | "partially_paid" | "paid" | "overpaid";
}

export const invoiceLabel = (i: { number: number | null; status: string }) =>
  i.number ? `Invoice #${String(i.number).padStart(4, "0")}` : i.status === "void" ? "Void draft" : "Draft invoice";

export interface CreditEntry {
  id: string; amountCents: number; kind: "received" | "from_invoice" | "reversal" | "applied" | "refunded";
  method: string | null; reference: string | null; note: string | null; reservationId: string | null;
  invoiceId: string | null; invoiceNumber: number | null; createdAt: string; recordedBy: string;
}

export interface Employee {
  id: string; userId: string; role: string; roleLabel: string; jobTitle: string | null; isActive: boolean; createdAt: string;
  firstName: string; lastName: string; email: string; phone: string | null; lastLoginAt: string | null;
  mustChangePassword: boolean; locationIds: string[]; canManage: boolean;
}

export interface SalesReport {
  from: string; to: string; timeZone: string;
  totals: { invoices: number; grossCents: number; discountCents: number; netCents: number; taxCents: number; invoicedCents: number;
    creditNotesCents: number; creditNotes: number; salesAfterCreditsCents: number };
  byService: { service: string; category: string | null; quantity: number; grossCents: number; discountCents: number; netCents: number }[];
  byMonth: { month: string; invoices: number; netCents: number; taxCents: number; creditNotesCents: number }[];
}
type MethodTotal = { method: string; count: number; cents: number };
export interface PaymentsReport {
  from: string; to: string; timeZone: string;
  payments: MethodTotal[]; refunds: MethodTotal[]; deposits: MethodTotal[];
  totals: { paymentsCents: number; creditAppliedCents: number; depositsCents: number; refundsCents: number; movedToCreditCents: number; netCollectedCents: number };
  byMethod: { method: string; inCents: number; outCents: number; netCents: number }[];
}
export interface BalancesReport {
  asOf: string;
  items: { customerId: string; customerName: string; owedCents: number; overpaidCents: number; creditCents: number; oldestUnpaid: string | null }[];
  totals: { owedCents: number; overpaidCents: number; creditCents: number };
}
type OccupancySummary = { petDays: number; averagePerDay: number; peak: number; utilizationPercent: number | null; limit: number | null };
export interface OccupancyReport {
  from: string; to: string;
  locations: { locationId: string; locationName: string; daycare: OccupancySummary; boarding: OccupancySummary;
    days: { date: string; daycare: number; boarding: number; daycareLimit: number | null; boardingLimit: number | null }[] }[];
}

export interface GroomingStaff { membershipId: string; name: string; role: string; jobTitle: string | null }
export interface GroomingAppointment {
  id: string; status: string; startsAt: string; endsAt: string; notes: string | null; groomerMembershipId: string | null;
  serviceName: string; customerId: string; customerName: string;
  pets: { id: string; name: string; breed: string | null; resourceName: string | null }[];
}
export interface GroomingSchedule {
  date: string; timeZone: string; location: { id: string; name: string };
  groomers: GroomingStaff[]; appointments: GroomingAppointment[];
}
