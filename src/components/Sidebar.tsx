"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { FolderKanban, LayoutDashboard, Settings, Users, Container, LogOut, History, Server, ShieldCheck, Archive, CalendarClock, Activity } from "lucide-react";

const nav = [
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/dashboard", label: "Updates", icon: LayoutDashboard },
  { href: "/endpoints", label: "Endpoints", icon: Server },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/backups", label: "Backups", icon: Archive },
  { href: "/tasks", label: "Scheduled tasks", icon: CalendarClock },
  { href: "/activity", label: "Audit log", icon: History },
  { href: "/team", label: "Team", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/account", label: "Account", icon: ShieldCheck },
];

interface Me {
  email: string;
  role: string;
  totpEnabled: boolean;
}

export default function Sidebar({ onSignOut }: { onSignOut: () => void }) {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => {});
  }, []);

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-64 bg-bg-secondary border-r border-border flex flex-col">
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/20 flex items-center justify-center">
            <Container className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary">DeployNow</h1>
            <p className="text-xs text-text-muted">by Encorp · v2</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {nav.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                isActive ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary hover:bg-bg-card",
              )}
            >
              <Icon className="w-4.5 h-4.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border space-y-2">
        {me && (
          <div className="px-3 text-xs">
            <p className="text-text-primary truncate">{me.email}</p>
            <p className="text-text-muted capitalize">
              {me.role}
              {!me.totpEnabled && <span className="text-warning normal-case"> · 2FA off</span>}
            </p>
          </div>
        )}
        <button
          onClick={onSignOut}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-text-secondary hover:text-danger hover:bg-danger/10 transition-all duration-200 w-full"
        >
          <LogOut className="w-4.5 h-4.5" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
