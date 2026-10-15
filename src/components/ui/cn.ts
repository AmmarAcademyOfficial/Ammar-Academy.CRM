import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names; later Tailwind classes override earlier ones (e.g. h-8 over h-10). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
