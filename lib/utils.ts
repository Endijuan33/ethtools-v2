import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge class names, resolving Tailwind conflicts.
 *
 * `clsx` flattens conditionals and `tailwind-merge` makes the last conflicting
 * utility win, so a caller can override a component's default without worrying
 * about class order — `cn("p-4", "p-6")` yields `p-6`.
 *
 * @param inputs - Class values, including conditionals and arrays.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
