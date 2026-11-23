"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import {
  Activity,
  Archive,
  CalendarClock,
  Container,
  FolderKanban,
  History,
  LogOut,
  PackageCheck,
  Server,
  Settings,
  ShieldAlert,
  Users,
  type LucideIcon,
} from "lucide-react";

type Role = "viewer" | "operator" | "admin" | "owner";
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

interface NavItem { href: string; label: string; icon: LucideIcon; min?: Role }

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Deploy",
    items: [
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/endpoints", label: "Endpoints", icon: Server },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/monitoring", label: "Monitoring", icon: Activity },
      { href: "/dashboard", label: "Image updates", icon: PackageCheck },
      { href: "/backups", label: "Backups", icon: Archive },
      { href: "/tasks", label: "Scheduled tasks", icon: CalendarClock },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/team", label: "Team", icon: Users },
      { href: "/activity", label: "Audit log", icon: History, min: "operator" },
      { href: "/settings", label: "Settings", icon: Settings, min: "admin" },
    ],
  },
];

export interface Me {
  email: string;
  name?: string;
  role: string;
  totpEnabled: boolean;
  passkeys?: number;
}

export default function Sidebar({ me, onSignOut, onNavigate }: { me: Me | null; onSignOut: () => void; onNavigate?: () => void }) {
  const pathname = usePathname();
  const rank = RANK[(me?.role as Role) ?? "viewer"] ?? 0;
  const no2fa = me && !me.totpEnabled && !me.passkeys;

  return (
    <div className="h-full bg-bg-secondary border-r border-border flex flex-col">
      <Link href="/projects" onClick={onNavigate} className="flex items-center gap-3 px-5 h-16 border-b border-border flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
          <Container className="w-4.5 h-4.5 text-accent" />
        </div>
        <div className="leading-tight">
          <p className="text-base font-bold text-text-primary">DeployNow</p>
          <p className="text-[11px] text-text-muted">by Encorp</p>
        </div>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Main">
        {groups.map((g) => {
          const items = g.items.filter((i) => !i.min || !me || rank >= RANK[i.min]);
          if (items.length === 0) return null;
          return (
            <div key={g.label}>
              <p className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{g.label}</p>
              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.href || pathname.startsWith(item.href + "/") || (item.href === "/projects" && pathname.startsWith("/apps/"));
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={clsx(
                        "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                        active ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary hover:bg-bg-card",
                      )}
                    >
                      <Icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="p-3 border-t border-border flex-shrink-0">
        {no2fa && (
          <Link
            href="/account?setup=2fa"
            onClick={onNavigate}
            className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-warning/10 text-warning text-xs hover:bg-warning/15"
          >
            <ShieldAlert className="w-4 h-4 flex-shrink-0" /> Turn on two-factor sign-in
          </Link>
        )}
        <div className="flex items-center gap-1">
          <Link
            href="/account"
            onClick={onNavigate}
            title="Your account and security"
            className={clsx(
              "flex-1 min-w-0 flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-bg-card",
              pathname.startsWith("/account") && "bg-bg-card",
            )}
          >
            <span className="w-8 h-8 rounded-full bg-accent/20 text-accent text-sm font-semibold flex items-center justify-center flex-shrink-0 uppercase">
              {(me?.name || me?.email || "?").slice(0, 1)}
            </span>
            <span className="min-w-0 text-xs leading-tight">
              <span className="block text-text-primary truncate">{me?.email ?? "…"}</span>
              <span className="block text-text-muted capitalize">{me?.role ?? ""}</span>
            </span>
          </Link>
          <button
            onClick={onSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
