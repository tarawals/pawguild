import { NavLink, Outlet } from "react-router";
import { useCan, useLogout, useMe } from "../auth";

export function Layout() {
  const me = useMe();
  const logout = useLogout();
  const canReadCustomers = useCan("customers:read");
  const canReadPets = useCan("pets:read");
  const canReadReservations = useCan("reservations:read");
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
          {canReadReservations && <NavLink to="/reservations">Reservations</NavLink>}
          <div className="nav-section">Clients</div>
          {canReadCustomers && <NavLink to="/customers">Customers</NavLink>}
          {canReadPets && <NavLink to="/pets">Pets</NavLink>}
          {canReadReservations && (
            <>
              <div className="nav-section">Business</div>
              <NavLink to="/services">Services</NavLink>
              <NavLink to="/capacity">Kennels &amp; capacity</NavLink>
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          <strong>{me.user.firstName} {me.user.lastName}</strong>
          {me.roleLabel}
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
