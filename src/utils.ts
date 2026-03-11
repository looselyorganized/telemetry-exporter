import { statSync } from "fs";

/** Check if a path is a directory, returning false on any error. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
