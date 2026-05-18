import * as React from "react";
import { cn } from "@/lib/utils";

type Elevation = 0 | 1 | 2 | 3;

const elevClass: Record<Elevation, string> = {
  0: "",
  1: "shadow-elev-1",
  2: "shadow-elev-2",
  3: "shadow-elev-3",
};

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  elevation?: Elevation;
  glass?: boolean;
  interactive?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, elevation = 1, glass = false, interactive = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        glass
          ? "glass-strong rounded-lg"
          : "rounded-lg bg-card text-card-foreground border border-slate-200/70",
        elevClass[elevation],
        interactive && "transition-shadow duration-200 hover:shadow-elev-2 cursor-pointer",
        className
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-4", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground flex items-center gap-2",
        className
      )}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-4 pt-0", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-4 pt-0", className)} {...props} />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
