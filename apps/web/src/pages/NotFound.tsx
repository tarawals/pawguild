import { Link } from "react-router";
import { EmptyState } from "../components/ui";

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <p>The page you're looking for doesn't exist. <Link to="/">Go to the dashboard</Link>.</p>
    </EmptyState>
  );
}
