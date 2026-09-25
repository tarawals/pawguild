import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { RequireAuth } from "./auth";
import { Layout } from "./components/Layout";
import { CapacityPage } from "./pages/Capacity";
import { IncidentsPage } from "./pages/Incidents";
import { InvoiceDetailPage } from "./pages/InvoiceDetail";
import { InvoicesPage } from "./pages/Invoices";
import { TodayCarePage } from "./pages/TodayCare";
import { CustomerDetailPage } from "./pages/CustomerDetail";
import { CustomerFormPage } from "./pages/CustomerForm";
import { CustomersPage } from "./pages/Customers";
import { DashboardPage } from "./pages/Dashboard";
import { LoginPage } from "./pages/Login";
import { NotFoundPage } from "./pages/NotFound";
import { PetDetailPage } from "./pages/PetDetail";
import { PetFormPage } from "./pages/PetForm";
import { PetsPage } from "./pages/Pets";
import { ReservationDetailPage } from "./pages/ReservationDetail";
import { ReservationFormPage } from "./pages/ReservationForm";
import { ReservationsPage } from "./pages/Reservations";
import { ServicesPage } from "./pages/Services";
import { ApiError } from "./api";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 15_000,
      // Don't retry requests the server refused (permissions, not found, validation): show the
      // message straight away. Retry network hiccups and server errors once.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<DashboardPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="customers/new" element={<CustomerFormPage />} />
            <Route path="customers/:id" element={<CustomerDetailPage />} />
            <Route path="customers/:id/edit" element={<CustomerFormPage />} />
            <Route path="customers/:customerId/pets/new" element={<PetFormPage />} />
            <Route path="pets" element={<PetsPage />} />
            <Route path="pets/:id" element={<PetDetailPage />} />
            <Route path="pets/:id/edit" element={<PetFormPage />} />
            <Route path="reservations" element={<ReservationsPage />} />
            <Route path="reservations/new" element={<ReservationFormPage />} />
            <Route path="reservations/:id" element={<ReservationDetailPage />} />
            <Route path="reservations/:id/edit" element={<ReservationFormPage />} />
            <Route path="services" element={<ServicesPage />} />
            <Route path="capacity" element={<CapacityPage />} />
            <Route path="care" element={<TodayCarePage />} />
            <Route path="incidents" element={<IncidentsPage />} />
            <Route path="invoices" element={<InvoicesPage />} />
            <Route path="invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
