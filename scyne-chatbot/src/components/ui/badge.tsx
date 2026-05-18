import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full font-medium transition-colors [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
        brand: "bg-scyne-ink-50 text-scyne-ink-700 ring-1 ring-scyne-ink-100",
        info: "bg-info-50 text-info-600 ring-1 ring-info-500/20",
        success: "bg-success-50 text-success-600 ring-1 ring-success-500/20",
        warning: "bg-warning-50 text-warning-600 ring-1 ring-warning-500/30",
        danger: "bg-danger-50 text-danger-600 ring-1 ring-danger-500/30",
        progress: "bg-progress-50 text-progress-600 ring-1 ring-progress-500/20",
        mono: "bg-slate-50 text-slate-600 ring-1 ring-slate-200 font-mono tracking-tight",
      },
      size: {
        sm: "px-1.5 py-0.5 text-[10.5px] leading-4",
        md: "px-2.5 py-1 text-xs leading-4",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  pulse?: boolean;
  icon?: React.ReactNode;
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, tone, size, pulse, icon, children, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {pulse && (
        <span className="size-1.5 rounded-full bg-current animate-pulse-dot" aria-hidden />
      )}
      {icon}
      {children}
    </span>
  )
);
Badge.displayName = "Badge";

export { Badge, badgeVariants };
