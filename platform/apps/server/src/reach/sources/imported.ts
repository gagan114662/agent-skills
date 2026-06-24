import { ProspectSourceUnavailableError, type ProspectSource } from "../prospect-source.js";
import type { RawProspect } from "../types.js";

export interface ImportedProspectSourceDeps {
  loadImportedProspects(input: {
    workspaceId: string;
    limit: number;
    excludeKeys: ReadonlySet<string>;
  }): Promise<RawProspect[]>;
}

export function createImportedProspectSource(workspaceId: string, deps: ImportedProspectSourceDeps): ProspectSource {
  return {
    kind: "imported",
    paid: false,
    estimateCostCents: () => 0,
    async search({ limit, excludeKeys }) {
      const prospects = await deps.loadImportedProspects({ workspaceId, limit, excludeKeys });
      if (prospects.length === 0) throw new ProspectSourceUnavailableError("imported", "no imported prospects configured");
      return { prospects, provider: "imported", creditsCents: 0 };
    },
  };
}
