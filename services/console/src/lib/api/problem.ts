import type { FieldValues, Path, UseFormSetError } from "react-hook-form";

/** RFC 9457 problem details, the error format of every Relay API. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: Array<{ field: string; message: string }>;
  [key: string]: unknown;
}

export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

export function isProblem(value: unknown): value is Problem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Problem).title === "string" &&
    typeof (value as Problem).status === "number"
  );
}

/** Turn any thrown value or error body into a problem the UI can show. */
export function toProblem(value: unknown, status = 0): Problem {
  if (value instanceof ProblemError) return value.problem;
  if (isProblem(value)) return value;
  if (value instanceof TypeError) {
    return { type: "/problems/network", title: "Cannot reach the server", status: 0, detail: value.message };
  }
  return { type: "about:blank", title: "Something went wrong", status };
}

/** The last path segment of a problem type: "/problems/email-taken" -> "email-taken". */
export function problemSlug(problem: Problem): string {
  return problem.type.split("/").pop() ?? "";
}

/**
 * Put a problem's message on the form field it concerns. Field errors in `errors` go to their
 * fields; otherwise `byType` maps a problem type (e.g. "blocked-destination") to a field.
 * Returns true if the problem was shown on a field, false if the caller should show it
 * as a general error.
 */
export function applyProblemToForm<T extends FieldValues>(
  problem: Problem,
  setError: UseFormSetError<T>,
  byType: Partial<Record<string, Path<T>>> = {},
): boolean {
  if (problem.errors?.length) {
    for (const e of problem.errors) setError(e.field as Path<T>, { type: "server", message: e.message });
    return true;
  }
  const field = byType[problemSlug(problem)];
  if (field) {
    setError(field, { type: "server", message: problem.detail ?? problem.title });
    return true;
  }
  return false;
}
