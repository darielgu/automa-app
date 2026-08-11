import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { useLocation } from "react-router-dom";
import { pageEnter } from "../../lib/motion.js";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarProvider, SidebarRail, SidebarTrigger } from "../components/sidebar.js";
import { cn } from "../lib/cn.js";

type WorkspaceFrameProps = {
  headerTag: string;
  headerTitle: string;
  sidebarHeader: ReactNode;
  sidebarNav: ReactNode;
  sidebarFooter?: ReactNode;
  headerRight?: ReactNode;
  headerContent?: ReactNode;
  headerIdentityClassName?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

export function WorkspaceFrame({
  headerTag,
  headerTitle,
  sidebarHeader,
  sidebarNav,
  sidebarFooter,
  headerRight,
  headerContent,
  headerIdentityClassName,
  children,
  className,
  contentClassName
}: WorkspaceFrameProps) {
  const location = useLocation();
  return (
    <SidebarProvider className={cn("min-h-screen bg-background", className)}>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>{sidebarHeader}</SidebarHeader>
        <SidebarContent>{sidebarNav}</SidebarContent>
        {sidebarFooter ? <SidebarFooter>{sidebarFooter}</SidebarFooter> : null}
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-screen">
        <div className="sticky top-0 z-30 border-b border-[var(--grid-line)] bg-background/88 backdrop-blur-md">
          <div className="flex flex-col gap-2.5 px-3 py-3 sm:px-4 lg:px-6">
            <div className="flex items-center justify-between gap-3">
              <div className={cn("flex items-center gap-2", headerIdentityClassName)}>
                <SidebarTrigger className="md:hidden" />
                <div className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    {headerTag}
                  </span>
                  <span className="text-sm font-medium">{headerTitle}</span>
                </div>
              </div>
              {headerRight}
            </div>
            {headerContent}
          </div>
        </div>
        {/*
          Keyed on the route so switching screens fades the content in without
          moving the sidebar or the app bar. Enter only: each screen mounts its
          own frame, so there is no exiting tree to hold, and waiting for one
          would just make every navigation feel slower.
        */}
        <motion.div
          key={location.pathname}
          variants={pageEnter}
          initial="initial"
          animate="animate"
          className={cn("flex flex-1 flex-col gap-4 px-3 py-4 sm:px-4 lg:px-6", contentClassName)}
        >
          {children}
        </motion.div>
      </SidebarInset>
    </SidebarProvider>
  );
}
