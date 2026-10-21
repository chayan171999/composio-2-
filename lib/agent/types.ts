import type { Guide } from "@/lib/schema";

export type ProgressEvent =
  | { type: "stage"; message: string }
  | { type: "fetch"; url: string; ok?: boolean }
  | { type: "warning"; message: string }
  | { type: "done"; guide: Guide }
  | { type: "error"; message: string };

export type ComposioCheck = {
  managedOAuth: "yes" | "no" | "unknown";
  method: "api" | "docs" | "none";
  /** True when the status was read from data rather than inferred by a model. */
  authoritative: boolean;
  toolkitSlug?: string;
  source?: { url: string; title: string };
  detail: string;
};
