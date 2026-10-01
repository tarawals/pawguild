import { formatMoney } from "@pawguild/shared";

interface Line { description: string; petCount: number; units: number; unitPriceCents: number; discountCents: number; amountCents: number }

/** The charges a stay works out to under the billing rules, line by line. */
export function EstimateLines({ estimate }: { estimate: { lines: Line[]; totalCents: number } }) {
  return (
    <table aria-label="Estimated charges">
      <tbody>
        {estimate.lines.map((l, i) => (
          <tr key={i}>
            <td style={{ paddingLeft: 0 }}>
              {l.description}{l.petCount > 1 && ` × ${l.petCount} pets`}
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {l.units * l.petCount} × {formatMoney(l.unitPriceCents)}{l.discountCents > 0 && ` − ${formatMoney(l.discountCents)} additional-pet discount`}
              </div>
            </td>
            <td style={{ textAlign: "right", paddingRight: 0, whiteSpace: "nowrap" }}>{formatMoney(l.amountCents)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr><th scope="row" style={{ paddingLeft: 0 }}>Estimate</th><td style={{ textAlign: "right", paddingRight: 0 }}><strong>{formatMoney(estimate.totalCents)}</strong></td></tr>
      </tfoot>
    </table>
  );
}
