/** Reservation lifecycle. Every status change must go through canTransition/assertTransition. */
export const RESERVATION_STATUSES = [
  "pending",
  "confirmed",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  checked_in: "Checked In",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No Show",
};

const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "cancelled", "no_show"],
  checked_in: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function allowedTransitions(from: ReservationStatus): readonly ReservationStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ReservationStatus,
    readonly to: ReservationStatus,
  ) {
    super(
      `A reservation that is ${RESERVATION_STATUS_LABELS[from]} cannot be changed to ${RESERVATION_STATUS_LABELS[to]}.`,
    );
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
