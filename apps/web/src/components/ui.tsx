import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { RESERVATION_STATUS_LABELS, type ReservationStatus } from "@pawguild/shared";
import { ApiError } from "../api";

export function PageHeader({ title, description, actions, breadcrumb }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode;
}) {
  return (
    <>
      {breadcrumb && <nav aria-label="Breadcrumb" className="breadcrumb">{breadcrumb}</nav>}
      <div className="page-header">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </>
  );
}

export function Panel({ title, actions, children, bodyless }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; bodyless?: boolean;
}) {
  const headingId = useId();
  return (
    <section className="panel" aria-labelledby={title ? headingId : undefined}>
      {title && (
        <div className="panel-header">
          <h2 id={headingId}>{title}</h2>
          {actions}
        </div>
      )}
      {bodyless ? children : <div className="panel-body">{children}</div>}
    </section>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : "Something went wrong. Please try again.";
  return <div role="alert" className="alert alert-error">{message}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="muted" role="status">{label}</p>;
}

type FieldProps = { label: string; error?: string; hint?: string; className?: string };

function FieldShell({ id, label, error, hint, className, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span id={`${id}-hint`} className="hint">{hint}</span>}
      {error && <span id={`${id}-error`} className="error">{error}</span>}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string) {
  return [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
}

export function TextField({ label, error, hint, className, ...props }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} className={className}>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...props} />
    </FieldShell>
  );
}

export function TextArea({ label, error, hint, className, ...props }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} className={className}>
      <textarea id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...props} />
    </FieldShell>
  );
}

export function SelectField({ label, error, hint, className, children, ...props }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} className={className}>
      <select id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...props}>
        {children}
      </select>
    </FieldShell>
  );
}

export function Checkbox({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field checkbox">
      <input id={id} type="checkbox" {...props} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "badge-success", inactive: "", banned: "badge-danger", deceased: "", archived: "",
};

export function StatusBadge({ status, archived }: { status: string; archived?: boolean }) {
  const key = archived ? "archived" : status;
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return <span className={`badge ${STATUS_TONE[key] ?? ""}`}>{label}</span>;
}

const RESERVATION_TONE: Record<string, string> = {
  pending: "badge-warning", confirmed: "badge-info", checked_in: "badge-success", completed: "",
  cancelled: "badge-muted", no_show: "badge-danger",
};

export function ReservationStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${RESERVATION_TONE[status] ?? ""}`}>{RESERVATION_STATUS_LABELS[status as ReservationStatus] ?? status}</span>;
}

/** Collects field-level errors from an ApiError for form rendering. */
export function fieldErrors(error: unknown): (path: string) => string | undefined {
  return (path) => (error instanceof ApiError ? error.fieldMessage(path) : undefined);
}
