import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Permission } from "@pawguild/shared";
import { createContext, useContext, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { ApiError, get, post, type Me } from "./api";
import { Loading } from "./components/ui";

const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe must be used inside <RequireAuth>");
  return me;
}

/** UI-only convenience for hiding controls. The API enforces every permission. */
export function useCan(permission: Permission): boolean {
  return useMe().permissions.includes(permission);
}

export function useMeQuery() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => get<Me>("/api/auth/me"),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 5 * 60_000,
  });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMeQuery();
  const location = useLocation();
  if (me.isPending) return <div className="content"><Loading /></div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return <div className="content"><div role="alert" className="alert alert-error">{me.error.message}</div></div>;
  }
  return <MeContext.Provider value={me.data}>{children}</MeContext.Provider>;
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post("/api/auth/logout"),
    onSettled: () => {
      qc.clear();
      window.location.assign("/login");
    },
  });
}
