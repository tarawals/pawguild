import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerFormPage } from "./CustomerForm";

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/customers/new"]}>
        <Routes>
          <Route path="/customers/new" element={<CustomerFormPage />} />
          <Route path="/customers/:id" element={<p>Customer page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("CustomerFormPage", () => {
  it("shows server validation errors next to the right fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "validation_failed", message: "Some fields need attention.",
        fields: [{ path: "email", message: "Enter a valid email address" }] } }), { status: 400 }),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText("First name"), "Dana");
    await userEvent.type(screen.getByLabelText("Last name"), "Whitfield");
    await userEvent.type(screen.getByLabelText("Email"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Create customer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Some fields need attention.");
    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Enter a valid email address");
  });

  it("sends the CSRF header and navigates to the new customer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 201 }),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText("First name"), "Dana");
    await userEvent.type(screen.getByLabelText("Last name"), "Whitfield");
    await userEvent.click(screen.getByRole("button", { name: "Create customer" }));
    expect(await screen.findByText("Customer page")).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["x-pawguild-request"]).toBe("1");
  });
});
