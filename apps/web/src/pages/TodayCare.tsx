import { useQuery } from "@tanstack/react-query";
import { get, type CareStay } from "../api";
import { CareCard } from "../components/CareCard";
import { EmptyState, ErrorAlert, Loading, PageHeader } from "../components/ui";

export function TodayCarePage() {
  const care = useQuery({
    queryKey: ["care", "today"],
    queryFn: () => get<{ stays: CareStay[] }>("/api/care/today"),
    refetchInterval: 60_000, // keep "overdue" and last-care times current on a shared screen
  });
  const overdue = care.data?.stays.flatMap((s) => s.pets.flatMap((p) => p.doses)).filter((d) => d.status === "overdue").length ?? 0;
  return (
    <>
      <PageHeader
        title="Today's care"
        description={care.data ? `${care.data.stays.reduce((n, s) => n + s.pets.length, 0)} pets in our care${overdue ? ` · ${overdue} medication dose${overdue === 1 ? "" : "s"} overdue` : ""}` : undefined}
      />
      <ErrorAlert error={care.error} />
      {care.isPending ? <Loading /> : care.data && (care.data.stays.length === 0
        ? <EmptyState title="No pets are checked in">Pets appear here once they're checked in.</EmptyState>
        : <div className="care-grid">{care.data.stays.map((s) => <CareCard key={s.id} stay={s} />)}</div>)}
    </>
  );
}
