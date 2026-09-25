export function InvoiceStatusBadge({ status, balanceCents, paidCents }: { status: string; balanceCents: number; paidCents: number }) {
  if (status === "draft") return <span className="badge badge-warning">Draft</span>;
  if (status === "void") return <span className="badge badge-muted">Void</span>;
  if (balanceCents <= 0) return <span className="badge badge-success">Paid</span>;
  if (paidCents > 0) return <span className="badge badge-info">Partly paid</span>;
  return <span className="badge badge-danger">Unpaid</span>;
}
