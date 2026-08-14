// Label（f2-4，shadcn 手写 minimal——无 Radix，原生 label 足够 f2 表单）。
import { forwardRef, type LabelHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label ref={ref} className={cn("text-sm font-medium text-foreground", className)} {...props} />
  ),
);
Label.displayName = "Label";
