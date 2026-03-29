"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import {
  LayoutDashboard,
  Settings,
  Users,
  Container,
  LogOut,
  History,
} from "lucide-react";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/activity", label: "Activity", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/team", label: "Team", icon: Users },
];

export default function Sidebar({ onSignOut }: { onSignOut: () => void }) {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-64 bg-bg-secondary border-r border-border flex flex-col">
      {/* Logo */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/20 flex items-center justify-center">
            <Container className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary">Deployer</h1>
            <p className="text-xs text-text-muted">by Encorp</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {nav.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-accent/15 text-accent"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-card"
              )}
            >
              <Icon className="w-4.5 h-4.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Sign out */}
      <div className="p-4 border-t border-border">
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
