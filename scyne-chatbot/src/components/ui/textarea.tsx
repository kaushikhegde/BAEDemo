import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const textareaVariants = cva(
  "flex w-full text-[15px] leading-relaxed placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 resize-none",
  {
    variants: {
      variant: {
        default:
          "min-h-[80px] rounded-lg border border-input bg-background px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        borderless:
          "bg-transparent border-0 px-0 py-1 focus:outline-none focus:ring-0",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(textareaVariants({ variant }), className)}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export { Textarea };
