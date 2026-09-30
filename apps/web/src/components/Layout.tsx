import { NavLink, Outlet } from "react-router";
import { useCan, useLogout, useMe } from "../auth";

export function Layout() {
  const me = useMe();
  const logout = useLogout();
  const canReadCustomers = useCan("customers:read");
  const canReadPets = useCan("pets:read");
  const canReadReservations = useCan("reservations:read");
  const canReadBilling = useCan("billing:read");
  const canReadStaff = useCan("employees:read");
  const canReadReports = useCan("reports:read");
  const canManageSettings = useCan("settings:manage");
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="PawGuild home">
          <img src="/favicon.svg" alt="" />
          PawGuild
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>Dashboard</NavLink>
          <div className="nav-section">Operations</div>
          {canReadReservations && <NavLink to="/care">Today's care</NavLink>}
          {canReadReservations && <NavLink to="/reservations">Reservations</NavLink>}
          {canReadReservations && <NavLink to="/grooming">Grooming</NavLink>}
          <NavLink to="/schedule">Staff schedule</NavLink>
          {canReadReservations && <NavLink to="/incidents">Incidents</NavLink>}
          {canReadBilling && <NavLink to="/invoices">Invoices</NavLink>}
          <div className="nav-section">Clients</div>
          {canReadCustomers && <NavLink to="/customers">Customers</NavLink>}
          {canReadPets && <NavLink to="/pets">Pets</NavLink>}
          {canReadReservations && (
            <>
              <div className="nav-section">Business</div>
              <NavLink to="/services">Services</NavLink>
              <NavLink to="/capacity">Locations</NavLink>
              {canReadReports && <NavLink to="/reports">Reports</NavLink>}
              {canReadStaff && <NavLink to="/staff">Staff</NavLink>}
              {canManageSettings && <NavLink to="/settings">Business settings</NavLink>}
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          <strong>{me.user.firstName} {me.user.lastName}</strong>
          {me.roleLabel}
          <div><NavLink to="/account/password" style={{ color: "#cfdcda", fontSize: "0.85rem" }}>Change password</NavLink></div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="org">{me.organization.name}</span>
          <button className="btn btn-small" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </button>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
