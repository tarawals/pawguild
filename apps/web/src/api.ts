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

export async function api<T>(method: "GET" | "POST" | "PATCH", url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" ? { "x-pawguild-request": "1" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined,
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

// ---- Response types (mirror the API) --------------------------------------------------------

export interface Me {
  user: { id: string; email: string; firstName: string; lastName: string };
  organization: { id: string; name: string; timezone: string; currency: string };
  role: string;
  roleLabel: string;
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
  priceUnit: string; durationMinutes: number | null; isActive: boolean;
}

export interface Location { id: string; name: string; timezone: string | null; isActive: boolean }

export interface ReservationListItem {
  id: string; status: string; startsAt: string; endsAt: string; customerId: string; customerName: string;
  serviceName: string; serviceCategory?: string; locationName?: string; petNames: string[];
}

export interface Reservation {
  id: string; status: string; startsAt: string; endsAt: string; notes: string | null;
  unitPriceCents: number; priceUnit: string; confirmedAt: string | null; checkedInAt: string | null;
  checkedOutAt: string | null; cancelledAt: string | null; cancellationReason: string | null; createdAt: string;
  customer: { id: string; firstName: string; lastName: string; phone: string | null };
  service: { id: string; name: string; category: string };
  location: { id: string; name: string };
  pets: { id: string; name: string; species: string; breed: string | null; allergies: string | null; medicalNotes: string | null }[];
  allowedTransitions: string[];
  estimate: { quantity: number; petCount: number; unitPriceCents: number; totalCents: number };
}

export interface DashboardSummary {
  activeCustomers: number;
  activePets: number;
  petsCheckedIn: number;
  arrivals: ReservationListItem[];
  departures: ReservationListItem[];
  vaccinationAlerts: { petId: string; petName: string; vaccine: string; expiresOn: string; customerName: string }[];
}
